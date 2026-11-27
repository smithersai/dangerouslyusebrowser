// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "services/network/dub/dub_network_interceptor.h"

#include <algorithm>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/byte_size.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_drainer.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/http/http_util.h"
#include "services/network/public/cpp/data_element.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/resource_request_body.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "third_party/re2/src/re2/re2.h"
#include "url/gurl.h"

namespace network::dub {
namespace {

constexpr size_t kMaxPatchBodyBytes = 16 * 1024 * 1024;
constexpr char kDubPatchedHeader[] = "X-Dub-Patched";

bool MatchesWildcard(std::string_view text, std::string_view pattern) {
  if (pattern.empty() || pattern == "*") {
    return true;
  }
  if (pattern.find('*') == std::string_view::npos) {
    return text.find(pattern) != std::string_view::npos;
  }
  size_t ti = 0;
  size_t pi = 0;
  size_t star_p = std::string_view::npos;
  size_t star_t = 0;
  while (ti < text.size()) {
    if (pi < pattern.size() && pattern[pi] == text[ti]) {
      ++ti;
      ++pi;
    } else if (pi < pattern.size() && pattern[pi] == '*') {
      star_p = pi++;
      star_t = ti;
    } else if (star_p != std::string_view::npos) {
      pi = star_p + 1;
      ti = ++star_t;
    } else {
      return false;
    }
  }
  while (pi < pattern.size() && pattern[pi] == '*') {
    ++pi;
  }
  return pi == pattern.size();
}

bool MatchesRule(const ResourceRequest& request,
                 const std::string& url_str,
                 const mojom::DubNetworkRulePtr& rule) {
  if (!rule->methods.empty()) {
    bool method_ok = false;
    for (const auto& m : rule->methods) {
      if (base::EqualsCaseInsensitiveASCII(m, request.method)) {
        method_ok = true;
        break;
      }
    }
    if (!method_ok) {
      return false;
    }
  }
  if (rule->is_regex) {
    RE2 re(rule->match);
    return re.ok() && RE2::PartialMatch(url_str, re);
  }
  return MatchesWildcard(url_str, rule->match);
}

int ParseNetError(const std::string& name) {
  if (name == "ERR_CONNECTION_RESET") return net::ERR_CONNECTION_RESET;
  if (name == "ERR_CONNECTION_REFUSED") return net::ERR_CONNECTION_REFUSED;
  if (name == "ERR_TIMED_OUT") return net::ERR_TIMED_OUT;
  if (name == "ERR_INTERNET_DISCONNECTED") return net::ERR_INTERNET_DISCONNECTED;
  if (name == "ERR_NAME_NOT_RESOLVED") return net::ERR_NAME_NOT_RESOLVED;
  if (name == "ERR_ABORTED") return net::ERR_ABORTED;
  return net::ERR_FAILED;
}

base::flat_map<std::string, std::string> ExtractRequestHeaders(
    const ResourceRequest& request) {
  base::flat_map<std::string, std::string> out;
  net::HttpRequestHeaders::Iterator it(request.headers);
  while (it.GetNext()) {
    out[it.name()] = it.value();
  }
  return out;
}

std::string ExtractRequestBody(const ResourceRequest& request,
                               size_t max_bytes,
                               bool* truncated) {
  *truncated = false;
  if (!request.request_body || !request.request_body->elements()) {
    return "";
  }
  std::string out;
  for (const auto& elem : *request.request_body->elements()) {
    if (elem.type() == DataElement::Tag::kBytes) {
      const auto& bytes = elem.As<DataElementBytes>().bytes();
      if (out.size() + bytes.size() > max_bytes) {
        size_t take = max_bytes > out.size() ? max_bytes - out.size() : 0;
        if (take > 0) {
          out.append(reinterpret_cast<const char*>(bytes.data()), take);
        }
        *truncated = true;
        break;
      }
      out.append(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
  }
  return out;
}

base::flat_map<std::string, std::string> ExtractResponseHeaders(
    const mojom::URLResponseHeadPtr& head) {
  base::flat_map<std::string, std::string> out;
  if (!head || !head->headers) {
    return out;
  }
  size_t iter = 0;
  std::string name;
  std::string value;
  while (head->headers->EnumerateHeaderLines(&iter, &name, &value)) {
    out[name] = value;
  }
  return out;
}

void WriteStringToPipe(mojo::ScopedDataPipeProducerHandle producer,
                       std::string body,
                       base::OnceClosure done) {
  auto pipe_producer =
      std::make_unique<mojo::DataPipeProducer>(std::move(producer));
  auto* raw_producer = pipe_producer.get();
  raw_producer->Write(
      std::make_unique<mojo::StringDataSource>(
          std::move(body), mojo::StringDataSource::AsyncWritingMode::
                               STRING_MAY_BE_INVALIDATED_BEFORE_COMPLETION),
      base::BindOnce(
          [](std::unique_ptr<mojo::DataPipeProducer> keep_alive,
             base::OnceClosure on_done, MojoResult result) {
            keep_alive.reset();
            if (on_done) {
              std::move(on_done).Run();
            }
          },
          std::move(pipe_producer), std::move(done)));
}

class MockURLLoader : public mojom::URLLoader {
 public:
  static void Start(mojo::PendingReceiver<mojom::URLLoader> receiver,
                    mojo::PendingRemote<mojom::URLLoaderClient> client,
                    int status_code,
                    const base::flat_map<std::string, std::string>& headers,
                    std::string body) {
    auto* self = new MockURLLoader(std::move(receiver), std::move(client));
    self->Deliver(status_code, headers, std::move(body));
  }

  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {}
  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {}

 private:
  MockURLLoader(mojo::PendingReceiver<mojom::URLLoader> receiver,
                mojo::PendingRemote<mojom::URLLoaderClient> client)
      : receiver_(this, std::move(receiver)), client_(std::move(client)) {
    receiver_.set_disconnect_handler(
        base::BindOnce(&MockURLLoader::OnDisconnect, base::Unretained(this)));
  }

  void Deliver(int status_code,
               const base::flat_map<std::string, std::string>& headers,
               std::string body) {
    auto head = mojom::URLResponseHead::New();
    std::string raw_headers =
        "HTTP/1.1 " + base::NumberToString(status_code) + " OK\0";
    bool has_content_type = false;
    bool has_content_length = false;
    bool has_cache_control = false;
    for (const auto& [k, v] : headers) {
      if (base::EqualsCaseInsensitiveASCII(k, "content-type")) {
        has_content_type = true;
      } else if (base::EqualsCaseInsensitiveASCII(k, "content-length")) {
        has_content_length = true;
      } else if (base::EqualsCaseInsensitiveASCII(k, "cache-control")) {
        has_cache_control = true;
      }
      raw_headers += k + ": " + v + '\0';
    }
    if (!has_content_type) {
      raw_headers += "Content-Type: application/octet-stream\0";
    }
    if (!has_content_length) {
      raw_headers +=
          "Content-Length: " + base::NumberToString(body.size()) + '\0';
    }
    if (!has_cache_control) {
      raw_headers += "Cache-Control: no-store\0";
    }
    raw_headers += '\0';

    head->headers =
        base::MakeRefCounted<net::HttpResponseHeaders>(raw_headers);
    std::string mime_type;
    std::string charset;
    head->headers->GetMimeTypeAndCharset(&mime_type, &charset);
    head->mime_type =
        mime_type.empty() ? "application/octet-stream" : mime_type;
    head->charset = charset;
    head->content_length = static_cast<int64_t>(body.size());
    head->was_fetched_via_cache = false;

    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
      client_->OnComplete(
          URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    const int64_t body_len = static_cast<int64_t>(body.size());
    client_->OnReceiveResponse(std::move(head), std::move(consumer),
                               std::nullopt);
    WriteStringToPipe(
        std::move(producer), std::move(body),
        base::BindOnce(&MockURLLoader::OnWriteComplete,
                       weak_factory_.GetWeakPtr(), body_len));
  }

  void OnWriteComplete(int64_t body_len) {
    URLLoaderCompletionStatus status(net::OK);
    const auto bytes = base::ByteSize(static_cast<uint64_t>(body_len));
    status.encoded_data_length = bytes;
    status.encoded_body_length = bytes;
    status.decoded_body_length = bytes;
    if (client_.is_bound()) {
      client_->OnComplete(status);
    }
    delete this;
  }

  void OnDisconnect() { delete this; }

  mojo::Receiver<mojom::URLLoader> receiver_;
  mojo::Remote<mojom::URLLoaderClient> client_;
  base::WeakPtrFactory<MockURLLoader> weak_factory_{this};
};

struct PatchRuleCopy {
  std::string id;
  std::string replace_text;
  std::string with_text;
  bool is_regex = false;
};

struct ResponseMutationCopy {
  std::string id;
  int status = 0;
  base::flat_map<std::string, std::string> set_headers;
  std::vector<std::string> remove_headers;
};

struct ResponseCallbackConfig {
  bool enabled = false;
  std::string rule_id;
  int timeout_ms = 10000;
  bool fail_open = true;
};

class DubProxyURLLoaderClient : public mojom::URLLoaderClient,
                                public mojo::DataPipeDrainer::Client {
 public:
  DubProxyURLLoaderClient(
      mojo::PendingReceiver<mojom::URLLoaderClient> receiver,
      mojo::PendingRemote<mojom::URLLoaderClient> downstream,
      std::string original_url,
      std::string final_url,
      std::string method,
      base::flat_map<std::string, std::string> req_headers,
      std::string req_body,
      uint64_t rule_version,
      std::string pre_action,
      std::string pre_rule_id,
      std::vector<PatchRuleCopy> patch_rules,
      std::vector<ResponseMutationCopy> response_mutations,
      ResponseCallbackConfig response_callback,
      bool capture_body,
      uint32_t max_capture_bytes)
      : receiver_(this, std::move(receiver)),
        downstream_(std::move(downstream)),
        original_url_(std::move(original_url)),
        final_url_(std::move(final_url)),
        method_(std::move(method)),
        req_headers_(std::move(req_headers)),
        req_body_(std::move(req_body)),
        rule_version_(rule_version),
        pre_action_(std::move(pre_action)),
        pre_rule_id_(std::move(pre_rule_id)),
        patch_rules_(std::move(patch_rules)),
        response_mutations_(std::move(response_mutations)),
        response_callback_(std::move(response_callback)),
        capture_body_(capture_body),
        max_capture_bytes_(max_capture_bytes) {
    receiver_.set_disconnect_handler(base::BindOnce(
        &DubProxyURLLoaderClient::OnReceiverDisconnect, base::Unretained(this)));
    downstream_.set_disconnect_handler(base::BindOnce(
        &DubProxyURLLoaderClient::OnDownstreamDisconnect,
        base::Unretained(this)));
  }

  void OnReceiveEarlyHints(mojom::EarlyHintsPtr early_hints) override {
    downstream_->OnReceiveEarlyHints(std::move(early_hints));
  }

  void OnReceiveResponse(
      mojom::URLResponseHeadPtr head,
      mojo::ScopedDataPipeConsumerHandle body,
      std::optional<mojo_base::BigBuffer> cached_metadata) override {
    status_code_ = head && head->headers ? head->headers->response_code() : 0;
    const bool already_patched =
        head && head->headers && head->headers->HasHeader(kDubPatchedHeader);

    // Apply static response header / status mutations immediately.
    if (head && head->headers && !response_mutations_.empty()) {
      for (const auto& mut : response_mutations_) {
        if (mut.status >= 100 && mut.status <= 599) {
          head->headers->ReplaceStatusLine(
              "HTTP/1.1 " + base::NumberToString(mut.status) + " OK");
          status_code_ = mut.status;
        }
        for (const auto& rem : mut.remove_headers) {
          head->headers->RemoveHeader(rem);
        }
        for (const auto& [k, v] : mut.set_headers) {
          head->headers->SetHeader(k, v);
        }
      }
    }

    res_headers_ = ExtractResponseHeaders(head);

    const bool needs_buffer =
        body.is_valid() && !already_patched &&
        (!patch_rules_.empty() || response_callback_.enabled || capture_body_);
    if (!needs_buffer) {
      EmitLog(pre_action_, pre_rule_id_, false, "", "");
      downstream_->OnReceiveResponse(std::move(head), std::move(body),
                                     std::move(cached_metadata));
      return;
    }

    buffering_ = true;
    pending_head_ = std::move(head);
    drainer_ = std::make_unique<mojo::DataPipeDrainer>(this, std::move(body));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect_info,
                         mojom::URLResponseHeadPtr head) override {
    final_url_ = redirect_info.new_url.spec();
    downstream_->OnReceiveRedirect(redirect_info, std::move(head));
  }

  void OnUploadProgress(int64_t current_position,
                        int64_t total_size,
                        OnUploadProgressCallback callback) override {
    downstream_->OnUploadProgress(current_position, total_size,
                                  std::move(callback));
  }

  void OnTransferSizeUpdated(int32_t transfer_size_diff) override {
    if (!buffering_) {
      downstream_->OnTransferSizeUpdated(transfer_size_diff);
    }
  }

  void OnComplete(const URLLoaderCompletionStatus& status) override {
    if (!buffering_) {
      if (!logged_) {
        EmitLog(pre_action_, pre_rule_id_, false,
                status.error_code == net::OK
                    ? ""
                    : net::ErrorToString(status.error_code),
                "");
      }
      downstream_->OnComplete(status);
      delete this;
      return;
    }
    completion_status_ = status;
    MaybeFinishBufferedResponse();
  }

  // mojo::DataPipeDrainer::Client:
  void OnDataAvailable(base::span<const uint8_t> data) override {
    if (body_overflow_) {
      return;
    }
    if (buffered_body_.size() + data.size() > kMaxPatchBodyBytes) {
      body_overflow_ = true;
      buffered_body_.clear();
      return;
    }
    buffered_body_.append(reinterpret_cast<const char*>(data.data()),
                          data.size());
  }

  void OnDataComplete() override {
    drainer_.reset();
    drain_complete_ = true;
    MaybeFinishBufferedResponse();
  }

 private:
  void MaybeFinishBufferedResponse() {
    if (!drain_complete_ || !completion_status_.has_value() ||
        awaiting_callback_) {
      return;
    }
    if (body_overflow_) {
      EmitLog(response_callback_.enabled ? "callback" : "patch",
              !patch_rules_.empty() ? patch_rules_.front().id
                                    : response_callback_.rule_id,
              false, "Response body exceeds 16 MiB buffer cap", "");
      downstream_->OnComplete(
          URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    if (response_callback_.enabled) {
      awaiting_callback_ = true;
      auto ev = mojom::DubNetworkCallbackEvent::New();
      ev->stage = "response";
      ev->rule_id = response_callback_.rule_id;
      ev->url = final_url_;
      ev->method = method_;
      ev->status = status_code_;
      ev->request_headers = req_headers_;
      ev->response_headers = res_headers_;
      if (buffered_body_.size() > max_capture_bytes_) {
        ev->body = buffered_body_.substr(0, max_capture_bytes_);
        ev->body_truncated = true;
      } else {
        ev->body = buffered_body_;
        ev->body_truncated = false;
      }
      ev->timeout_ms = response_callback_.timeout_ms;
      ev->fail_open = response_callback_.fail_open;

      DubNetworkInterceptor::GetInstance().InvokeObserverCallback(
          std::move(ev),
          base::BindOnce(&DubProxyURLLoaderClient::OnResponseCallbackDecision,
                         weak_factory_.GetWeakPtr()));
      return;
    }

    FinalizeAndDeliver(false, pre_action_, pre_rule_id_);
  }

  void OnResponseCallbackDecision(
      mojom::DubNetworkCallbackDecisionPtr decision) {
    awaiting_callback_ = false;
    if (!decision || decision->action.empty() ||
        decision->action == "continue") {
      FinalizeAndDeliver(false, "callback", response_callback_.rule_id);
      return;
    }
    if (decision->action == "block") {
      const int err_code = decision->fail_error.empty()
                               ? net::ERR_BLOCKED_BY_CLIENT
                               : ParseNetError(decision->fail_error);
      EmitLog("block", response_callback_.rule_id, false,
              net::ErrorToString(err_code), "");
      downstream_->OnComplete(URLLoaderCompletionStatus(err_code));
      delete this;
      return;
    }
    // "mock" or "modify": rewrite status, headers, and/or body.
    if (pending_head_ && pending_head_->headers) {
      if (decision->status >= 100 && decision->status <= 599) {
        pending_head_->headers->ReplaceStatusLine(
            "HTTP/1.1 " + base::NumberToString(decision->status) + " OK");
        status_code_ = decision->status;
      }
      for (const auto& [k, v] : decision->headers) {
        pending_head_->headers->SetHeader(k, v);
      }
    }
    if (decision->has_body) {
      buffered_body_ = decision->body;
    }
    res_headers_ = ExtractResponseHeaders(pending_head_);
    FinalizeAndDeliver(true, decision->action, response_callback_.rule_id);
  }

  void FinalizeAndDeliver(bool callback_rewrote,
                          const std::string& log_action,
                          const std::string& log_rule_id) {
    bool any_replaced = callback_rewrote;
    std::string final_action = log_action;
    std::string matched_rule_id = log_rule_id;

    if (!patch_rules_.empty()) {
      matched_rule_id = patch_rules_.front().id;
      final_action = "patch";
      for (const auto& rule : patch_rules_) {
        if (rule.replace_text.empty()) {
          continue;
        }
        bool rule_hit = false;
        if (rule.is_regex) {
          RE2 re(rule.replace_text);
          if (re.ok()) {
            rule_hit =
                RE2::GlobalReplace(&buffered_body_, re, rule.with_text) > 0;
          }
        } else {
          size_t pos = 0;
          while ((pos = buffered_body_.find(rule.replace_text, pos)) !=
                 std::string::npos) {
            buffered_body_.replace(pos, rule.replace_text.size(),
                                   rule.with_text);
            pos += rule.with_text.size();
            rule_hit = true;
          }
        }
        if (rule_hit) {
          any_replaced = true;
          matched_rule_id = rule.id;
        }
      }
    }

    if (any_replaced || !patch_rules_.empty() || callback_rewrote) {
      if (pending_head_ && pending_head_->headers) {
        pending_head_->headers->RemoveHeader("Content-Encoding");
        pending_head_->headers->SetHeader(
            "Content-Length", base::NumberToString(buffered_body_.size()));
        pending_head_->headers->SetHeader(kDubPatchedHeader, "1");
      }
      if (pending_head_) {
        pending_head_->client_side_content_decoding_types.clear();
        pending_head_->content_length =
            static_cast<int64_t>(buffered_body_.size());
      }
    }

    std::string log_body;
    if (capture_body_) {
      log_body = buffered_body_.size() > max_capture_bytes_
                     ? buffered_body_.substr(0, max_capture_bytes_)
                     : buffered_body_;
    }
    EmitLog(final_action, matched_rule_id, any_replaced, "", log_body);

    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
      downstream_->OnComplete(
          URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    const int64_t body_len = static_cast<int64_t>(buffered_body_.size());
    downstream_->OnReceiveResponse(std::move(pending_head_),
                                   std::move(consumer), std::nullopt);
    WriteStringToPipe(
        std::move(producer), std::move(buffered_body_),
        base::BindOnce(&DubProxyURLLoaderClient::OnPatchedWriteDone,
                       weak_factory_.GetWeakPtr(), body_len));
  }

  void OnPatchedWriteDone(int64_t body_len) {
    URLLoaderCompletionStatus status = *completion_status_;
    if (status.error_code == net::OK) {
      const auto bytes = base::ByteSize(static_cast<uint64_t>(body_len));
      status.encoded_data_length = bytes;
      status.encoded_body_length = bytes;
      status.decoded_body_length = bytes;
    }
    if (downstream_.is_bound()) {
      downstream_->OnComplete(status);
    }
    delete this;
  }

  void EmitLog(const std::string& action,
               const std::string& rule_id,
               bool patched,
               const std::string& error,
               const std::string& captured_response_body) {
    if (logged_) {
      return;
    }
    logged_ = true;
    auto entry = mojom::DubNetworkLogEntry::New();
    entry->url = original_url_;
    entry->final_url = final_url_;
    entry->method = method_;
    entry->source = "network";
    entry->rule_id = rule_id;
    entry->rule_version = rule_version_;
    entry->action = action;
    entry->status = status_code_;
    entry->patched = patched;
    entry->error = error;
    if (capture_body_) {
      entry->request_headers = req_headers_;
      entry->response_headers = res_headers_;
      entry->request_body = req_body_;
      entry->response_body = captured_response_body;
      entry->body_truncated = buffered_body_.size() > max_capture_bytes_;
    }
    DubNetworkInterceptor::GetInstance().EmitEvent(std::move(entry));
  }

  void OnReceiverDisconnect() {
    receiver_.reset();
    if (buffering_ || awaiting_callback_ || completion_status_.has_value()) {
      return;
    }
    delete this;
  }

  void OnDownstreamDisconnect() { delete this; }

  mojo::Receiver<mojom::URLLoaderClient> receiver_;
  mojo::Remote<mojom::URLLoaderClient> downstream_;
  std::string original_url_;
  std::string final_url_;
  std::string method_;
  base::flat_map<std::string, std::string> req_headers_;
  std::string req_body_;
  base::flat_map<std::string, std::string> res_headers_;
  uint64_t rule_version_ = 0;
  std::string pre_action_;
  std::string pre_rule_id_;
  std::vector<PatchRuleCopy> patch_rules_;
  std::vector<ResponseMutationCopy> response_mutations_;
  ResponseCallbackConfig response_callback_;
  bool capture_body_ = false;
  uint32_t max_capture_bytes_ = 262144;
  bool buffering_ = false;
  bool awaiting_callback_ = false;
  bool drain_complete_ = false;
  bool body_overflow_ = false;
  bool logged_ = false;
  int status_code_ = 0;
  mojom::URLResponseHeadPtr pending_head_;
  std::string buffered_body_;
  std::unique_ptr<mojo::DataPipeDrainer> drainer_;
  std::optional<URLLoaderCompletionStatus> completion_status_;
  base::WeakPtrFactory<DubProxyURLLoaderClient> weak_factory_{this};
};

}  // namespace

DubNetworkInterceptor::DubNetworkInterceptor() = default;
DubNetworkInterceptor::~DubNetworkInterceptor() = default;

DubNetworkInterceptor& DubNetworkInterceptor::GetInstance() {
  static base::NoDestructor<DubNetworkInterceptor> instance;
  return *instance;
}

void DubNetworkInterceptor::SetPolicy(
    uint64_t version,
    std::vector<mojom::DubNetworkRulePtr> rules,
    mojo::PendingRemote<mojom::DubNetworkObserver> observer) {
  version_ = version;
  rules_ = std::move(rules);
  if (observer.is_valid()) {
    observer_.reset();
    observer_.Bind(std::move(observer));
    observer_.reset_on_disconnect();
  }
}

void DubNetworkInterceptor::SetConfig(bool capture_bodies,
                                      uint32_t max_capture_bytes) {
  capture_bodies_ = capture_bodies;
  max_capture_bytes_ =
      std::clamp<uint32_t>(max_capture_bytes == 0 ? 262144 : max_capture_bytes,
                           1024, 4 * 1024 * 1024);
}

bool DubNetworkInterceptor::HasActiveRules() const {
  return !rules_.empty();
}

bool DubNetworkInterceptor::HasObserver() const {
  return observer_.is_bound();
}

void DubNetworkInterceptor::EmitEvent(mojom::DubNetworkLogEntryPtr entry) {
  if (observer_.is_bound()) {
    observer_->OnNetworkEvent(std::move(entry));
  }
}

void DubNetworkInterceptor::InvokeObserverCallback(
    mojom::DubNetworkCallbackEventPtr event,
    base::OnceCallback<void(mojom::DubNetworkCallbackDecisionPtr)> done) {
  if (!observer_.is_bound()) {
    std::move(done).Run(nullptr);
    return;
  }
  observer_->OnNetworkCallback(
      std::move(event),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          std::move(done), mojom::DubNetworkCallbackDecisionPtr()));
}

bool DubNetworkInterceptor::Intercept(
    mojo::PendingReceiver<mojom::URLLoader>& loader,
    uint32_t& options,
    ResourceRequest& request,
    mojo::PendingRemote<mojom::URLLoaderClient>& client,
    ProceedCallback proceed) {
  if (rules_.empty() && !observer_.is_bound()) {
    return false;
  }

  const std::string original_url = request.url.spec();
  std::string final_url = original_url;
  std::string pre_action = "pass";
  std::string pre_rule_id;
  std::vector<PatchRuleCopy> patch_rules;
  std::vector<ResponseMutationCopy> response_mutations;
  ResponseCallbackConfig response_callback;
  int total_delay_ms = 0;

  bool req_body_truncated = false;
  const std::string captured_req_body =
      capture_bodies_ ? ExtractRequestBody(request, max_capture_bytes_,
                                           &req_body_truncated)
                      : "";

  for (const auto& rule : rules_) {
    if (!MatchesRule(request, final_url, rule)) {
      continue;
    }

    if (rule->action == "block") {
      const int err_code = rule->fail_error.empty()
                               ? net::ERR_BLOCKED_BY_CLIENT
                               : ParseNetError(rule->fail_error);
      auto entry = mojom::DubNetworkLogEntry::New();
      entry->url = original_url;
      entry->final_url = final_url;
      entry->method = request.method;
      entry->source = "network";
      entry->rule_id = rule->id;
      entry->rule_version = version_;
      entry->action = "block";
      entry->status = 0;
      entry->patched = false;
      entry->error = net::ErrorToString(err_code);
      EmitEvent(std::move(entry));

      mojo::Remote<mojom::URLLoaderClient> remote_client(std::move(client));
      remote_client->OnComplete(URLLoaderCompletionStatus(err_code));
      return true;
    }

    if (rule->action == "mock") {
      auto entry = mojom::DubNetworkLogEntry::New();
      entry->url = original_url;
      entry->final_url = final_url;
      entry->method = request.method;
      entry->source = "network";
      entry->rule_id = rule->id;
      entry->rule_version = version_;
      entry->action = "mock";
      entry->status = rule->status;
      entry->patched = false;
      if (capture_bodies_) {
        entry->request_headers = ExtractRequestHeaders(request);
        entry->response_headers = rule->headers;
        entry->request_body = captured_req_body;
        entry->response_body = rule->body.substr(0, max_capture_bytes_);
      }
      EmitEvent(std::move(entry));

      MockURLLoader::Start(std::move(loader), std::move(client), rule->status,
                           rule->headers, rule->body);
      return true;
    }

    if (rule->action == "redirect" && pre_action == "pass") {
      GURL target(rule->redirect_url);
      if (target.is_valid()) {
        request.url = target;
        request.load_flags |= net::LOAD_BYPASS_CACHE;
        final_url = target.spec();
        pre_action = "redirect";
        pre_rule_id = rule->id;
      }
    } else if (rule->action == "patch") {
      request.load_flags |= net::LOAD_BYPASS_CACHE;
      request.client_side_content_decoding_enabled = false;
      patch_rules.push_back(
          {rule->id, rule->replace_text, rule->with_text, rule->patch_regex});
    } else if (rule->action == "modify") {
      request.load_flags |= net::LOAD_BYPASS_CACHE;
      for (const auto& rem : rule->remove_request_headers) {
        request.headers.RemoveHeader(rem);
      }
      for (const auto& [k, v] : rule->set_request_headers) {
        request.headers.SetHeader(k, v);
      }
      if (!rule->fail_error.empty()) {
        const int err_code = ParseNetError(rule->fail_error);
        auto entry = mojom::DubNetworkLogEntry::New();
        entry->url = original_url;
        entry->final_url = final_url;
        entry->method = request.method;
        entry->source = "network";
        entry->rule_id = rule->id;
        entry->rule_version = version_;
        entry->action = "modify";
        entry->error = net::ErrorToString(err_code);
        EmitEvent(std::move(entry));
        mojo::Remote<mojom::URLLoaderClient> remote_client(std::move(client));
        remote_client->OnComplete(URLLoaderCompletionStatus(err_code));
        return true;
      }
      if (rule->delay_ms > 0) {
        total_delay_ms += rule->delay_ms;
      }
      if (rule->jitter_ms > 0) {
        total_delay_ms += static_cast<int>(base::RandGenerator(
            static_cast<uint64_t>(rule->jitter_ms) + 1));
      }
      if (rule->status >= 100 || !rule->set_response_headers.empty() ||
          !rule->remove_response_headers.empty()) {
        response_mutations.push_back({rule->id, rule->status,
                                      rule->set_response_headers,
                                      rule->remove_response_headers});
      }
      if (pre_action == "pass") {
        pre_action = "modify";
        pre_rule_id = rule->id;
      }
    } else if (rule->action == "callback" && observer_.is_bound()) {
      request.load_flags |= net::LOAD_BYPASS_CACHE;
      const bool on_req =
          rule->callback_stage.empty() || rule->callback_stage == "request" ||
          rule->callback_stage == "both";
      const bool on_res =
          rule->callback_stage == "response" || rule->callback_stage == "both";
      if (on_res) {
        request.client_side_content_decoding_enabled = false;
        response_callback.enabled = true;
        response_callback.rule_id = rule->id;
        response_callback.timeout_ms =
            rule->callback_timeout_ms > 0 ? rule->callback_timeout_ms : 10000;
        response_callback.fail_open = rule->fail_open;
      }
      if (on_req && proceed) {
        auto ev = mojom::DubNetworkCallbackEvent::New();
        ev->stage = "request";
        ev->rule_id = rule->id;
        ev->url = final_url;
        ev->method = request.method;
        ev->status = 0;
        ev->request_headers = ExtractRequestHeaders(request);
        bool trunc = false;
        ev->body = ExtractRequestBody(request, max_capture_bytes_, &trunc);
        ev->body_truncated = trunc;
        ev->timeout_ms =
            rule->callback_timeout_ms > 0 ? rule->callback_timeout_ms : 10000;
        ev->fail_open = rule->fail_open;

        auto req_copy = std::make_unique<ResourceRequest>(request);
        const uint64_t ver = version_;
        const bool cap = capture_bodies_;
        const uint32_t cap_bytes = max_capture_bytes_;
        const std::string r_id = rule->id;
        const bool fail_open = rule->fail_open;

        InvokeObserverCallback(
            std::move(ev),
            base::BindOnce(
                [](mojo::PendingReceiver<mojom::URLLoader> ldr, uint32_t opts,
                   std::unique_ptr<ResourceRequest> req,
                   mojo::PendingRemote<mojom::URLLoaderClient> cli,
                   ProceedCallback cont, std::string orig_url, std::string r_id,
                   uint64_t ver, bool cap, uint32_t cap_bytes, bool fail_open,
                   std::vector<PatchRuleCopy> patches,
                   std::vector<ResponseMutationCopy> muts,
                   ResponseCallbackConfig res_cb,
                   mojom::DubNetworkCallbackDecisionPtr dec) {
                  if (!dec || dec->action.empty() ||
                      dec->action == "continue") {
                    if (!dec && !fail_open) {
                      mojo::Remote<mojom::URLLoaderClient> rc(std::move(cli));
                      rc->OnComplete(
                          URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
                      return;
                    }
                    auto req_hdrs = ExtractRequestHeaders(*req);
                    bool t = false;
                    std::string rbody =
                        cap ? ExtractRequestBody(*req, cap_bytes, &t) : "";
                    mojo::PendingRemote<mojom::URLLoaderClient> proxy;
                    new DubProxyURLLoaderClient(
                        proxy.InitWithNewPipeAndPassReceiver(), std::move(cli),
                        orig_url, req->url.spec(), req->method,
                        std::move(req_hdrs), std::move(rbody), ver, "callback",
                        r_id, std::move(patches), std::move(muts),
                        std::move(res_cb), cap, cap_bytes);
                    std::move(cont).Run(std::move(ldr), opts, std::move(*req),
                                        std::move(proxy));
                    return;
                  }
                  if (dec->action == "block") {
                    const int ec = dec->fail_error.empty()
                                       ? net::ERR_BLOCKED_BY_CLIENT
                                       : ParseNetError(dec->fail_error);
                    auto entry = mojom::DubNetworkLogEntry::New();
                    entry->url = orig_url;
                    entry->final_url = req->url.spec();
                    entry->method = req->method;
                    entry->source = "network";
                    entry->rule_id = r_id;
                    entry->rule_version = ver;
                    entry->action = "block";
                    entry->error = net::ErrorToString(ec);
                    DubNetworkInterceptor::GetInstance().EmitEvent(
                        std::move(entry));
                    mojo::Remote<mojom::URLLoaderClient> rc(std::move(cli));
                    rc->OnComplete(URLLoaderCompletionStatus(ec));
                    return;
                  }
                  if (dec->action == "mock") {
                    const int st = dec->status >= 100 && dec->status <= 599
                                       ? dec->status
                                       : 200;
                    auto entry = mojom::DubNetworkLogEntry::New();
                    entry->url = orig_url;
                    entry->final_url = req->url.spec();
                    entry->method = req->method;
                    entry->source = "network";
                    entry->rule_id = r_id;
                    entry->rule_version = ver;
                    entry->action = "mock";
                    entry->status = st;
                    DubNetworkInterceptor::GetInstance().EmitEvent(
                        std::move(entry));
                    MockURLLoader::Start(std::move(ldr), std::move(cli), st,
                                         dec->headers, dec->body);
                    return;
                  }
                  // "modify": update outgoing request URL / headers / body.
                  if (!dec->url.empty() && GURL(dec->url).is_valid()) {
                    req->url = GURL(dec->url);
                  }
                  for (const auto& [k, v] : dec->request_headers) {
                    req->headers.SetHeader(k, v);
                  }
                  if (dec->has_body) {
                    auto new_body = base::MakeRefCounted<ResourceRequestBody>();
                    new_body->AppendCopyOfBytes(base::as_byte_span(dec->body));
                    req->request_body = std::move(new_body);
                  }
                  auto req_hdrs = ExtractRequestHeaders(*req);
                  bool t = false;
                  std::string rbody =
                      cap ? ExtractRequestBody(*req, cap_bytes, &t) : "";
                  mojo::PendingRemote<mojom::URLLoaderClient> proxy;
                  new DubProxyURLLoaderClient(
                      proxy.InitWithNewPipeAndPassReceiver(), std::move(cli),
                      orig_url, req->url.spec(), req->method,
                      std::move(req_hdrs), std::move(rbody), ver, "modify",
                      r_id, std::move(patches), std::move(muts),
                      std::move(res_cb), cap, cap_bytes);
                  std::move(cont).Run(std::move(ldr), opts, std::move(*req),
                                      std::move(proxy));
                },
                std::move(loader), options, std::move(req_copy),
                std::move(client), std::move(proceed), original_url, r_id, ver,
                cap, cap_bytes, fail_open, std::move(patch_rules),
                std::move(response_mutations), std::move(response_callback)));
        return true;
      }
    }
  }

  if (patch_rules.empty() && response_mutations.empty() &&
      !response_callback.enabled && pre_action == "pass" &&
      total_delay_ms == 0 && !observer_.is_bound()) {
    return false;
  }

  if (capture_bodies_) {
    request.client_side_content_decoding_enabled = false;
  }

  auto req_hdrs = capture_bodies_ || response_callback.enabled
                      ? ExtractRequestHeaders(request)
                      : base::flat_map<std::string, std::string>();
  mojo::PendingRemote<mojom::URLLoaderClient> proxy_remote;
  new DubProxyURLLoaderClient(
      proxy_remote.InitWithNewPipeAndPassReceiver(), std::move(client),
      original_url, final_url, request.method, std::move(req_hdrs),
      captured_req_body, version_, std::move(pre_action),
      std::move(pre_rule_id), std::move(patch_rules),
      std::move(response_mutations), std::move(response_callback),
      capture_bodies_, max_capture_bytes_);
  client = std::move(proxy_remote);

  if (total_delay_ms > 0 && proceed) {
    auto req_copy = std::make_unique<ResourceRequest>(request);
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](ProceedCallback cont, mojo::PendingReceiver<mojom::URLLoader> l,
               uint32_t o, std::unique_ptr<ResourceRequest> r,
               mojo::PendingRemote<mojom::URLLoaderClient> c) {
              std::move(cont).Run(std::move(l), o, std::move(*r), std::move(c));
            },
            std::move(proceed), std::move(loader), options, std::move(req_copy),
            std::move(client)),
        base::Milliseconds(std::min(total_delay_ms, 60000)));
    return true;
  }
  return false;
}

}  // namespace network::dub

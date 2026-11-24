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
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/data_pipe_drainer.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/http/http_util.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace network::dub {
namespace {

constexpr size_t kMaxPatchBodyBytes = 16 * 1024 * 1024;
constexpr char kDubPatchedHeader[] = "X-Dub-Patched";

// Wildcard matcher: '*' matches any sequence of characters. If pattern has no
// '*', matches as a substring of `text` so simple host/path filters work too.
bool MatchesPattern(std::string_view text, std::string_view pattern) {
  if (pattern.empty()) {
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

// Self-owning mock URLLoader that delivers a synthesized HTTP response + body.
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
      client_->OnComplete(URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    const int64_t body_len = static_cast<int64_t>(body.size());
    client_->OnReceiveResponse(std::move(head), std::move(consumer),
                               std::nullopt);
    WriteStringToPipe(
        std::move(producer), std::move(body),
        base::BindOnce(&MockURLLoader::OnWriteComplete, weak_factory_.GetWeakPtr(),
                       body_len));
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
};

// Self-owning URLLoaderClient proxy that intercepts decoded response bodies,
// applies text patches, updates headers, invalidates cached metadata, and logs.
class DubProxyURLLoaderClient : public mojom::URLLoaderClient,
                                public mojo::DataPipeDrainer::Client {
 public:
  DubProxyURLLoaderClient(
      mojo::PendingReceiver<mojom::URLLoaderClient> receiver,
      mojo::PendingRemote<mojom::URLLoaderClient> downstream,
      std::string original_url,
      std::string final_url,
      std::string method,
      uint64_t rule_version,
      std::string pre_action,
      std::string pre_rule_id,
      std::vector<PatchRuleCopy> patch_rules)
      : receiver_(this, std::move(receiver)),
        downstream_(std::move(downstream)),
        original_url_(std::move(original_url)),
        final_url_(std::move(final_url)),
        method_(std::move(method)),
        rule_version_(rule_version),
        pre_action_(std::move(pre_action)),
        pre_rule_id_(std::move(pre_rule_id)),
        patch_rules_(std::move(patch_rules)) {
    receiver_.set_disconnect_handler(base::BindOnce(
        &DubProxyURLLoaderClient::OnReceiverDisconnect, base::Unretained(this)));
    downstream_.set_disconnect_handler(base::BindOnce(
        &DubProxyURLLoaderClient::OnDownstreamDisconnect,
        base::Unretained(this)));
  }

  void OnReceiveEarlyHints(mojom::EarlyHintsPtr early_hints) override {
    downstream_->OnReceiveEarlyHints(std::move(early_hints));
  }

  void OnReceiveResponse(mojom::URLResponseHeadPtr head,
                         mojo::ScopedDataPipeConsumerHandle body,
                         std::optional<mojo_base::BigBuffer> cached_metadata) override {
    status_code_ = head && head->headers ? head->headers->response_code() : 0;
    const bool already_patched =
        head && head->headers && head->headers->HasHeader(kDubPatchedHeader);
    if (patch_rules_.empty() || !body.is_valid() || already_patched) {
      EmitLog(pre_action_, pre_rule_id_, false, "");
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
                    : net::ErrorToString(status.error_code));
      }
      downstream_->OnComplete(status);
      delete this;
      return;
    }
    completion_status_ = status;
    MaybeFinishPatchedResponse();
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
    MaybeFinishPatchedResponse();
  }

 private:
  void MaybeFinishPatchedResponse() {
    if (!drain_complete_ || !completion_status_.has_value()) {
      return;
    }
    if (body_overflow_) {
      EmitLog("patch", patch_rules_.front().id, false,
              "Response body exceeds 16 MiB patch cap");
      downstream_->OnComplete(
          URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    bool any_replaced = false;
    std::string matched_rule_id = patch_rules_.front().id;
    for (const auto& rule : patch_rules_) {
      if (rule.replace_text.empty()) {
        continue;
      }
      size_t pos = 0;
      bool rule_hit = false;
      while ((pos = buffered_body_.find(rule.replace_text, pos)) !=
             std::string::npos) {
        buffered_body_.replace(pos, rule.replace_text.size(), rule.with_text);
        pos += rule.with_text.size();
        rule_hit = true;
      }
      if (rule_hit) {
        any_replaced = true;
        matched_rule_id = rule.id;
      }
    }

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

    EmitLog("patch", matched_rule_id, any_replaced, "");

    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
      downstream_->OnComplete(
          URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      delete this;
      return;
    }

    const int64_t body_len = static_cast<int64_t>(buffered_body_.size());
    // Strip cached_metadata so V8 never runs stale bytecode for patched JS.
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
               const std::string& error) {
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
    DubNetworkInterceptor::GetInstance().EmitEvent(std::move(entry));
  }

  void OnReceiverDisconnect() {
    receiver_.reset();
    if (buffering_ || completion_status_.has_value()) {
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
  uint64_t rule_version_ = 0;
  std::string pre_action_;
  std::string pre_rule_id_;
  std::vector<PatchRuleCopy> patch_rules_;
  bool buffering_ = false;
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

bool DubNetworkInterceptor::Intercept(
    mojo::PendingReceiver<mojom::URLLoader>& loader,
    uint32_t& options,
    ResourceRequest& request,
    mojo::PendingRemote<mojom::URLLoaderClient>& client) {
  if (rules_.empty() && !observer_.is_bound()) {
    return false;
  }

  const std::string original_url = request.url.spec();
  std::string final_url = original_url;
  std::string pre_action = "pass";
  std::string pre_rule_id;
  std::vector<PatchRuleCopy> patch_rules;

  for (const auto& rule : rules_) {
    if (!MatchesPattern(final_url, rule->match)) {
      continue;
    }
    if (rule->action == "block") {
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
      entry->error = "ERR_BLOCKED_BY_CLIENT";
      EmitEvent(std::move(entry));

      mojo::Remote<mojom::URLLoaderClient> remote_client(std::move(client));
      remote_client->OnComplete(
          URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
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
      patch_rules.push_back({rule->id, rule->replace_text, rule->with_text});
    }
  }

  if (patch_rules.empty() && pre_action == "pass" && !observer_.is_bound()) {
    return false;
  }

  mojo::PendingRemote<mojom::URLLoaderClient> proxy_remote;
  new DubProxyURLLoaderClient(
      proxy_remote.InitWithNewPipeAndPassReceiver(), std::move(client),
      original_url, final_url, request.method, version_, std::move(pre_action),
      std::move(pre_rule_id), std::move(patch_rules));
  client = std::move(proxy_remote);
  return false;
}

}  // namespace network::dub

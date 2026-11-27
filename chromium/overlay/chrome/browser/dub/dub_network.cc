// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_network.h"

#include <algorithm>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/dub/dub_events.h"
#include "components/web_cache/browser/web_cache_manager.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/network_service_instance.h"
#include "url/gurl.h"

namespace dub {
namespace {

constexpr size_t kMaxLogEntries = 2000;

base::DictValue SerializeHeaderMap(
    const base::flat_map<std::string, std::string>& hdrs) {
  base::DictValue out;
  for (const auto& [k, v] : hdrs) {
    out.Set(k, v);
  }
  return out;
}

base::DictValue SerializeRule(const NetworkRuleRecord& r) {
  base::DictValue d;
  d.Set("id", r.id);
  d.Set("match", r.match);
  d.Set("action", r.action);
  if (r.is_regex) d.Set("regex", true);
  if (!r.plugin_id.empty()) d.Set("pluginId", r.plugin_id);
  if (!r.methods.empty()) {
    base::ListValue ms;
    for (const auto& m : r.methods) ms.Append(m);
    d.Set("methods", std::move(ms));
  }
  if (r.action == "mock") {
    d.Set("status", r.status);
    d.Set("bodyLength", static_cast<int>(r.body.size()));
    d.Set("headers", SerializeHeaderMap(r.headers));
  } else if (r.action == "redirect") {
    d.Set("url", r.redirect_url);
  } else if (r.action == "patch") {
    d.Set("replace", r.replace_text);
    d.Set("with", r.with_text);
    if (r.patch_regex) d.Set("patchRegex", true);
  } else if (r.action == "modify") {
    if (r.status > 0) d.Set("status", r.status);
    if (r.delay_ms > 0) d.Set("delayMs", r.delay_ms);
    if (r.jitter_ms > 0) d.Set("jitterMs", r.jitter_ms);
    if (!r.fail_error.empty()) d.Set("failError", r.fail_error);
  } else if (r.action == "callback") {
    d.Set("stage", r.callback_stage.empty() ? "request" : r.callback_stage);
    d.Set("timeoutMs", r.callback_timeout_ms);
    d.Set("failOpen", r.fail_open);
  }
  return d;
}

bool MatchesLogFilter(const std::string& text, const std::string& filter) {
  if (filter.empty()) {
    return true;
  }
  return text.find(filter) != std::string::npos;
}

void ReadHeaderMap(const base::DictValue* dict,
                   base::flat_map<std::string, std::string>* out) {
  if (!dict) return;
  for (const auto [k, v] : *dict) {
    if (v.is_string()) {
      (*out)[k] = v.GetString();
    }
  }
}

void ReadStringList(const base::ListValue* list, std::vector<std::string>* out) {
  if (!list) return;
  for (const auto& v : *list) {
    if (v.is_string() && !v.GetString().empty()) {
      out->push_back(v.GetString());
    }
  }
}

}  // namespace

DubNetworkManager::DubNetworkManager() = default;
DubNetworkManager::~DubNetworkManager() = default;

DubNetworkManager& DubNetworkManager::GetInstance() {
  static base::NoDestructor<DubNetworkManager> instance;
  return *instance;
}

void DubNetworkManager::OnNetworkServiceCreated(
    network::mojom::NetworkService* service) {
  if (!service) {
    return;
  }
  SyncToNetworkService(service);
}

std::vector<network::mojom::DubNetworkRulePtr>
DubNetworkManager::BuildMojomRules() const {
  std::vector<network::mojom::DubNetworkRulePtr> out;
  out.reserve(rules_.size());
  for (const auto& r : rules_) {
    auto m = network::mojom::DubNetworkRule::New();
    m->id = r.id;
    m->match = r.match;
    m->action = r.action;
    m->status = r.status;
    m->body = r.body;
    m->headers = r.headers;
    m->redirect_url = r.redirect_url;
    m->replace_text = r.replace_text;
    m->with_text = r.with_text;
    m->is_regex = r.is_regex;
    m->patch_regex = r.patch_regex;
    m->methods = r.methods;
    m->plugin_id = r.plugin_id;
    m->set_request_headers = r.set_request_headers;
    m->remove_request_headers = r.remove_request_headers;
    m->set_response_headers = r.set_response_headers;
    m->remove_response_headers = r.remove_response_headers;
    m->delay_ms = r.delay_ms;
    m->jitter_ms = r.jitter_ms;
    m->fail_error = r.fail_error;
    m->callback_stage = r.callback_stage;
    m->callback_timeout_ms = r.callback_timeout_ms;
    m->fail_open = r.fail_open;
    out.push_back(std::move(m));
  }
  return out;
}

void DubNetworkManager::SyncToNetworkService(
    network::mojom::NetworkService* service) {
  if (!service) {
    return;
  }
  mojo::PendingRemote<network::mojom::DubNetworkObserver> observer_remote;
  observer_receivers_.Add(this,
                          observer_remote.InitWithNewPipeAndPassReceiver());
  service->SetDubNetworkConfig(capture_bodies_, max_capture_bytes_);
  service->SetDubNetworkPolicy(version_, BuildMojomRules(),
                               std::move(observer_remote));
}

void DubNetworkManager::ClearRendererMemoryCaches() {
  if (auto* cache = web_cache::WebCacheManager::GetInstance()) {
    cache->ClearCache();
  }
}

base::DictValue DubNetworkManager::SetConfig(const base::DictValue& params) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (auto cap = params.FindBool("captureBodies")) {
    capture_bodies_ = *cap;
  }
  if (auto max_b = params.FindInt("maxBodyBytes")) {
    max_capture_bytes_ =
        std::clamp<uint32_t>(static_cast<uint32_t>(std::max(*max_b, 1024)),
                             1024, 4 * 1024 * 1024);
  }
  SyncToNetworkService(content::GetNetworkService());
  base::DictValue out;
  out.Set("captureBodies", capture_bodies_);
  out.Set("maxBodyBytes", static_cast<int>(max_capture_bytes_));
  return out;
}

base::DictValue DubNetworkManager::SetRule(const base::DictValue& params,
                                           std::string* error) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const std::string* match = params.FindString("match");
  const std::string* action = params.FindString("action");
  if (!match || match->empty() || !action || action->empty()) {
    *error = "Expected non-empty match and action";
    return base::DictValue();
  }
  if (*action != "mock" && *action != "block" && *action != "redirect" &&
      *action != "patch" && *action != "modify" && *action != "callback") {
    *error =
        "action must be one of mock, block, redirect, patch, modify, callback";
    return base::DictValue();
  }

  NetworkRuleRecord record;
  if (const std::string* custom_id = params.FindString("id");
      custom_id && !custom_id->empty()) {
    record.id = *custom_id;
  } else {
    record.id = "rule-" + base::NumberToString(next_rule_id_++);
  }
  record.match = *match;
  record.action = *action;
  record.is_regex = params.FindBool("regex").value_or(false);
  record.patch_regex = params.FindBool("patchRegex").value_or(false);
  ReadStringList(params.FindList("methods"), &record.methods);
  if (const std::string* pid = params.FindString("pluginId")) {
    record.plugin_id = *pid;
  }
  if (const std::string* fail_err = params.FindString("failError")) {
    record.fail_error = *fail_err;
  }

  if (*action == "mock") {
    record.status = params.FindInt("status").value_or(200);
    if (record.status < 100 || record.status > 599) {
      *error = "mock status must be 100-599";
      return base::DictValue();
    }
    if (const std::string* body = params.FindString("body")) {
      record.body = *body;
    }
    ReadHeaderMap(params.FindDict("headers"), &record.headers);
  } else if (*action == "redirect") {
    const std::string* url = params.FindString("url");
    if (!url || !GURL(*url).is_valid()) {
      *error = "redirect requires valid url";
      return base::DictValue();
    }
    record.redirect_url = *url;
  } else if (*action == "patch") {
    const std::string* replace = params.FindString("replace");
    const std::string* with = params.FindString("with");
    if (!replace || replace->empty() || !with) {
      *error = "patch requires non-empty replace and string with";
      return base::DictValue();
    }
    record.replace_text = *replace;
    record.with_text = *with;
  } else if (*action == "modify") {
    record.status = params.FindInt("status").value_or(0);
    record.delay_ms = std::clamp(params.FindInt("delayMs").value_or(0), 0, 60000);
    record.jitter_ms = std::clamp(params.FindInt("jitterMs").value_or(0), 0, 30000);
    ReadHeaderMap(params.FindDict("setRequestHeaders"),
                  &record.set_request_headers);
    ReadStringList(params.FindList("removeRequestHeaders"),
                   &record.remove_request_headers);
    ReadHeaderMap(params.FindDict("setResponseHeaders"),
                  &record.set_response_headers);
    ReadStringList(params.FindList("removeResponseHeaders"),
                   &record.remove_response_headers);
  } else if (*action == "callback") {
    const std::string* stage = params.FindString("stage");
    record.callback_stage = stage && !stage->empty() ? *stage : "request";
    if (record.callback_stage != "request" &&
        record.callback_stage != "response" &&
        record.callback_stage != "both") {
      *error = "callback stage must be request, response, or both";
      return base::DictValue();
    }
    record.callback_timeout_ms =
        std::clamp(params.FindInt("timeoutMs").value_or(15000), 100, 120000);
    record.fail_open = params.FindBool("failOpen").value_or(true);
  }

  auto it = std::find_if(rules_.begin(), rules_.end(), [&](const auto& r) {
    return r.id == record.id;
  });
  if (it != rules_.end()) {
    *it = record;
  } else {
    rules_.push_back(record);
  }
  ++version_;
  SyncToNetworkService(content::GetNetworkService());
  ClearRendererMemoryCaches();

  base::DictValue res;
  res.Set("id", record.id);
  res.Set("version", static_cast<int>(version_));
  res.Set("rule", SerializeRule(record));
  return res;
}

base::DictValue DubNetworkManager::ListRules() const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  base::ListValue list;
  for (const auto& r : rules_) {
    list.Append(SerializeRule(r));
  }
  base::DictValue res;
  res.Set("version", static_cast<int>(version_));
  res.Set("rules", std::move(list));
  return res;
}

bool DubNetworkManager::RemoveRule(const std::string& id,
                                   base::DictValue* out) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto it = std::find_if(rules_.begin(), rules_.end(),
                         [&](const auto& r) { return r.id == id; });
  if (it == rules_.end()) {
    return false;
  }
  rules_.erase(it);
  ++version_;
  SyncToNetworkService(content::GetNetworkService());
  ClearRendererMemoryCaches();
  out->Set("removed", true);
  out->Set("id", id);
  out->Set("version", static_cast<int>(version_));
  return true;
}

base::DictValue DubNetworkManager::RemoveByPlugin(
    const std::string& plugin_id) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  int removed = 0;
  auto it = std::remove_if(rules_.begin(), rules_.end(), [&](const auto& r) {
    if (r.plugin_id == plugin_id) {
      ++removed;
      return true;
    }
    return false;
  });
  rules_.erase(it, rules_.end());
  if (removed > 0) {
    ++version_;
    SyncToNetworkService(content::GetNetworkService());
    ClearRendererMemoryCaches();
  }
  base::DictValue out;
  out.Set("pluginId", plugin_id);
  out.Set("removed", removed);
  out.Set("version", static_cast<int>(version_));
  return out;
}

void DubNetworkManager::RecordLocalEvent(NetworkLogRecord record) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  record.seq = next_log_seq_++;
  if (record.timestamp_ms == 0) {
    record.timestamp_ms = base::Time::Now().InMillisecondsSinceUnixEpoch();
  }
  base::DictValue ev;
  ev.Set("seq", static_cast<int>(record.seq));
  ev.Set("url", record.url);
  ev.Set("finalUrl", record.final_url);
  ev.Set("method", record.method);
  ev.Set("action", record.action);
  ev.Set("status", record.status);
  ev.Set("ruleId", record.rule_id);
  DubEventHub::GetInstance().EmitEvent("net.event", std::move(ev));

  logs_.push_back(std::move(record));
  while (logs_.size() > kMaxLogEntries) {
    logs_.pop_front();
    ++dropped_logs_;
  }
}

void DubNetworkManager::OnNetworkEvent(
    network::mojom::DubNetworkLogEntryPtr entry) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  NetworkLogRecord rec;
  rec.url = entry->url;
  rec.final_url = entry->final_url;
  rec.method = entry->method;
  rec.source = entry->source;
  rec.rule_id = entry->rule_id;
  rec.rule_version = entry->rule_version;
  rec.action = entry->action;
  rec.status = entry->status;
  rec.patched = entry->patched;
  rec.error = entry->error;
  rec.request_headers = std::move(entry->request_headers);
  rec.response_headers = std::move(entry->response_headers);
  rec.request_body = std::move(entry->request_body);
  rec.response_body = std::move(entry->response_body);
  rec.body_truncated = entry->body_truncated;
  RecordLocalEvent(std::move(rec));
}

void DubNetworkManager::OnNetworkCallback(
    network::mojom::DubNetworkCallbackEventPtr event,
    OnNetworkCallbackCallback callback) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  base::DictValue data;
  data.Set("stage", event->stage);
  data.Set("ruleId", event->rule_id);
  data.Set("url", event->url);
  data.Set("method", event->method);
  data.Set("status", event->status);
  data.Set("requestHeaders", SerializeHeaderMap(event->request_headers));
  data.Set("responseHeaders", SerializeHeaderMap(event->response_headers));
  data.Set("body", event->body);
  data.Set("bodyTruncated", event->body_truncated);

  const std::string kind =
      event->stage == "response" ? "net.response" : "net.request";
  const bool fail_open = event->fail_open;
  const int timeout_ms = event->timeout_ms > 0 ? event->timeout_ms : 15000;

  DubEventHub::GetInstance().InvokeCallback(
      kind, std::move(data), timeout_ms,
      base::BindOnce(
          [](OnNetworkCallbackCallback done, bool fail_open_fallback,
             std::optional<base::DictValue> decision_dict) {
            auto dec = network::mojom::DubNetworkCallbackDecision::New();
            if (!decision_dict) {
              dec->action = fail_open_fallback ? "continue" : "block";
              std::move(done).Run(std::move(dec));
              return;
            }
            if (const std::string* act = decision_dict->FindString("action")) {
              dec->action = *act;
            } else {
              dec->action = "continue";
            }
            if (const std::string* url = decision_dict->FindString("url")) {
              dec->url = *url;
            }
            dec->status = decision_dict->FindInt("status").value_or(0);
            ReadHeaderMap(decision_dict->FindDict("headers"), &dec->headers);
            ReadHeaderMap(decision_dict->FindDict("requestHeaders"),
                          &dec->request_headers);
            if (const std::string* body = decision_dict->FindString("body")) {
              dec->has_body = true;
              dec->body = *body;
            }
            if (const std::string* err =
                    decision_dict->FindString("failError")) {
              dec->fail_error = *err;
            }
            std::move(done).Run(std::move(dec));
          },
          std::move(callback), fail_open));
}

base::DictValue DubNetworkManager::ReadLog(const std::string& match,
                                           uint64_t since) const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const uint64_t oldest_seq = logs_.empty() ? next_log_seq_ : logs_.front().seq;
  const bool gap = since > 0 && since + 1 < oldest_seq;

  base::ListValue entries;
  for (const auto& e : logs_) {
    if (e.seq <= since) {
      continue;
    }
    if (!MatchesLogFilter(e.url, match) &&
        !MatchesLogFilter(e.final_url, match)) {
      continue;
    }
    base::DictValue d;
    d.Set("seq", static_cast<int>(e.seq));
    d.Set("timestampMs", static_cast<double>(e.timestamp_ms));
    d.Set("url", e.url);
    d.Set("finalUrl", e.final_url);
    d.Set("method", e.method);
    d.Set("source", e.source);
    d.Set("ruleId", e.rule_id);
    d.Set("ruleVersion", static_cast<int>(e.rule_version));
    d.Set("action", e.action);
    d.Set("status", e.status);
    d.Set("patched", e.patched);
    if (!e.error.empty()) {
      d.Set("error", e.error);
    }
    if (!e.request_headers.empty() || !e.response_headers.empty() ||
        !e.request_body.empty() || !e.response_body.empty()) {
      d.Set("hasDetails", true);
    }
    entries.Append(std::move(d));
  }

  base::DictValue res;
  res.Set("version", static_cast<int>(version_));
  res.Set("nextSeq", static_cast<int>(next_log_seq_ - 1));
  res.Set("oldestSeq", static_cast<int>(oldest_seq));
  res.Set("droppedCount", static_cast<int>(dropped_logs_));
  res.Set("gap", gap);
  res.Set("entries", std::move(entries));
  return res;
}

base::DictValue DubNetworkManager::InspectEntry(uint64_t seq,
                                                bool* found) const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  for (const auto& e : logs_) {
    if (e.seq == seq) {
      *found = true;
      base::DictValue d;
      d.Set("seq", static_cast<int>(e.seq));
      d.Set("timestampMs", static_cast<double>(e.timestamp_ms));
      d.Set("url", e.url);
      d.Set("finalUrl", e.final_url);
      d.Set("method", e.method);
      d.Set("source", e.source);
      d.Set("ruleId", e.rule_id);
      d.Set("ruleVersion", static_cast<int>(e.rule_version));
      d.Set("action", e.action);
      d.Set("status", e.status);
      d.Set("patched", e.patched);
      if (!e.error.empty()) d.Set("error", e.error);
      d.Set("requestHeaders", SerializeHeaderMap(e.request_headers));
      d.Set("responseHeaders", SerializeHeaderMap(e.response_headers));
      d.Set("requestBody", e.request_body);
      d.Set("responseBody", e.response_body);
      d.Set("bodyTruncated", e.body_truncated);
      return d;
    }
  }
  *found = false;
  return base::DictValue();
}

}  // namespace dub

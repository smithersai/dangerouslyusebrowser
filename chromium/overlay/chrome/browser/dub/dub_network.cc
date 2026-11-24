// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_network.h"

#include <algorithm>
#include <string>
#include <utility>

#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/time/time.h"
#include "components/web_cache/browser/web_cache_manager.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/network_service_instance.h"
#include "url/gurl.h"

namespace dub {
namespace {

constexpr size_t kMaxLogEntries = 2000;

base::DictValue SerializeRule(const NetworkRuleRecord& r) {
  base::DictValue d;
  d.Set("id", r.id);
  d.Set("match", r.match);
  d.Set("action", r.action);
  if (r.action == "mock") {
    d.Set("status", r.status);
    d.Set("bodyLength", static_cast<int>(r.body.size()));
    base::DictValue hdrs;
    for (const auto& [k, v] : r.headers) {
      hdrs.Set(k, v);
    }
    d.Set("headers", std::move(hdrs));
  } else if (r.action == "redirect") {
    d.Set("url", r.redirect_url);
  } else if (r.action == "patch") {
    d.Set("replace", r.replace_text);
    d.Set("with", r.with_text);
  }
  return d;
}

bool MatchesLogFilter(const std::string& text, const std::string& filter) {
  if (filter.empty()) {
    return true;
  }
  return text.find(filter) != std::string::npos;
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
  service->SetDubNetworkPolicy(version_, BuildMojomRules(),
                               std::move(observer_remote));
}

void DubNetworkManager::ClearRendererMemoryCaches() {
  if (auto* cache = web_cache::WebCacheManager::GetInstance()) {
    cache->ClearCache();
  }
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
      *action != "patch") {
    *error = "action must be one of mock, block, redirect, patch";
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

  if (*action == "mock") {
    record.status = params.FindInt("status").value_or(200);
    if (record.status < 100 || record.status > 599) {
      *error = "mock status must be 100-599";
      return base::DictValue();
    }
    if (const std::string* body = params.FindString("body")) {
      record.body = *body;
    }
    if (const base::DictValue* hdrs = params.FindDict("headers")) {
      for (const auto [k, v] : *hdrs) {
        if (v.is_string()) {
          record.headers[k] = v.GetString();
        }
      }
    }
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
  }

  // Replace existing rule with same ID if present, otherwise append.
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

void DubNetworkManager::RecordLocalEvent(NetworkLogRecord record) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  record.seq = next_log_seq_++;
  if (record.timestamp_ms == 0) {
    record.timestamp_ms =
        base::Time::Now().InMillisecondsSinceUnixEpoch();
  }
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
  RecordLocalEvent(std::move(rec));
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

}  // namespace dub

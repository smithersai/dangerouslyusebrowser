// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_NETWORK_H_
#define CHROME_BROWSER_DUB_DUB_NETWORK_H_

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "base/containers/flat_map.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "services/network/public/mojom/network_service.mojom.h"

namespace dub {

struct NetworkRuleRecord {
  std::string id;
  std::string match;
  std::string action;
  int status = 0;
  std::string body;
  base::flat_map<std::string, std::string> headers;
  std::string redirect_url;
  std::string replace_text;
  std::string with_text;
  bool is_regex = false;
  bool patch_regex = false;
  std::vector<std::string> methods;
  std::string plugin_id;
  base::flat_map<std::string, std::string> set_request_headers;
  std::vector<std::string> remove_request_headers;
  base::flat_map<std::string, std::string> set_response_headers;
  std::vector<std::string> remove_response_headers;
  int delay_ms = 0;
  int jitter_ms = 0;
  std::string fail_error;
  std::string callback_stage;
  int callback_timeout_ms = 10000;
  bool fail_open = true;
};

struct NetworkLogRecord {
  uint64_t seq = 0;
  int64_t timestamp_ms = 0;
  std::string url;
  std::string final_url;
  std::string method;
  std::string source;
  std::string rule_id;
  uint64_t rule_version = 0;
  std::string action;
  int status = 0;
  bool patched = false;
  std::string error;
  base::flat_map<std::string, std::string> request_headers;
  base::flat_map<std::string, std::string> response_headers;
  std::string request_body;
  std::string response_body;
  bool body_truncated = false;
};

class DubNetworkManager : public network::mojom::DubNetworkObserver {
 public:
  static DubNetworkManager& GetInstance();

  void OnNetworkServiceCreated(network::mojom::NetworkService* service);

  base::DictValue SetRule(const base::DictValue& params, std::string* error);
  base::DictValue ListRules() const;
  bool RemoveRule(const std::string& id, base::DictValue* out);
  base::DictValue RemoveByPlugin(const std::string& plugin_id);
  base::DictValue SetConfig(const base::DictValue& params);
  base::DictValue ReadLog(const std::string& match, uint64_t since) const;
  base::DictValue InspectEntry(uint64_t seq, bool* found) const;

  void RecordLocalEvent(NetworkLogRecord record);

  // network::mojom::DubNetworkObserver:
  void OnNetworkEvent(network::mojom::DubNetworkLogEntryPtr entry) override;
  void OnNetworkCallback(network::mojom::DubNetworkCallbackEventPtr event,
                         OnNetworkCallbackCallback callback) override;

 private:
  friend class base::NoDestructor<DubNetworkManager>;
  DubNetworkManager();
  ~DubNetworkManager() override;

  std::vector<network::mojom::DubNetworkRulePtr> BuildMojomRules() const;
  void SyncToNetworkService(network::mojom::NetworkService* service);
  void ClearRendererMemoryCaches();

  uint64_t version_ = 0;
  uint64_t next_rule_id_ = 1;
  uint64_t next_log_seq_ = 1;
  uint64_t dropped_logs_ = 0;
  bool capture_bodies_ = false;
  uint32_t max_capture_bytes_ = 262144;
  std::vector<NetworkRuleRecord> rules_;
  std::deque<NetworkLogRecord> logs_;
  mojo::ReceiverSet<network::mojom::DubNetworkObserver> observer_receivers_;
};

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_NETWORK_H_

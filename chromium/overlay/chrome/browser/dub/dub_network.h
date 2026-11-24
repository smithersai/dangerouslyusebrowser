// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_NETWORK_H_
#define CHROME_BROWSER_DUB_DUB_NETWORK_H_

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "base/values.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "services/network/public/mojom/network_service.mojom.h"

namespace dub {

struct NetworkRuleRecord {
  std::string id;
  std::string match;
  std::string action;
  int status = 200;
  std::string body;
  base::flat_map<std::string, std::string> headers;
  std::string redirect_url;
  std::string replace_text;
  std::string with_text;
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
};

class DubNetworkManager : public network::mojom::DubNetworkObserver {
 public:
  DubNetworkManager();
  DubNetworkManager(const DubNetworkManager&) = delete;
  DubNetworkManager& operator=(const DubNetworkManager&) = delete;
  ~DubNetworkManager() override;

  static DubNetworkManager& GetInstance();

  // Called from ChromeContentBrowserClient::OnNetworkServiceCreated so a
  // network-service startup or crash/restart automatically replays policy.
  void OnNetworkServiceCreated(network::mojom::NetworkService* service);

  base::DictValue SetRule(const base::DictValue& params, std::string* error);
  base::DictValue ListRules() const;
  bool RemoveRule(const std::string& id, base::DictValue* out);
  base::DictValue ReadLog(const std::string& match, uint64_t since) const;

  void RecordLocalEvent(NetworkLogRecord record);
  const std::vector<NetworkRuleRecord>& rules() const { return rules_; }
  uint64_t version() const { return version_; }

  // network::mojom::DubNetworkObserver:
  void OnNetworkEvent(network::mojom::DubNetworkLogEntryPtr entry) override;

 private:
  void SyncToNetworkService(network::mojom::NetworkService* service);
  std::vector<network::mojom::DubNetworkRulePtr> BuildMojomRules() const;
  void ClearRendererMemoryCaches();

  uint64_t version_ = 0;
  uint64_t next_rule_id_ = 1;
  uint64_t next_log_seq_ = 1;
  uint64_t dropped_logs_ = 0;
  std::vector<NetworkRuleRecord> rules_;
  std::deque<NetworkLogRecord> logs_;
  mojo::ReceiverSet<network::mojom::DubNetworkObserver> observer_receivers_;
};

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_NETWORK_H_

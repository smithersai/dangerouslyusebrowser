// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_
#define SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_

#include <cstdint>
#include <string>
#include <vector>

#include "base/component_export.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/network_service.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"

namespace network {

struct ResourceRequest;

namespace dub {

class COMPONENT_EXPORT(NETWORK_SERVICE) DubNetworkInterceptor {
 public:
  DubNetworkInterceptor();
  DubNetworkInterceptor(const DubNetworkInterceptor&) = delete;
  DubNetworkInterceptor& operator=(const DubNetworkInterceptor&) = delete;
  ~DubNetworkInterceptor();

  static DubNetworkInterceptor& GetInstance();

  void SetPolicy(uint64_t version,
                 std::vector<mojom::DubNetworkRulePtr> rules,
                 mojo::PendingRemote<mojom::DubNetworkObserver> observer);

  bool HasActiveRules() const;
  bool HasObserver() const;
  uint64_t version() const { return version_; }

  // Called from PrefetchMatchingURLLoaderFactory::CreateLoaderAndStart.
  // Returns true if Dub completely handled the request (block or mock) and the
  // caller should return immediately.
  // Returns false if the request should continue to next_->CreateLoaderAndStart
  // (potentially with `request` modified for redirect/cache-bypass and `client`
  // wrapped for response body patching or logging).
  bool Intercept(mojo::PendingReceiver<mojom::URLLoader>& loader,
                 uint32_t& options,
                 ResourceRequest& request,
                 mojo::PendingRemote<mojom::URLLoaderClient>& client);

  void EmitEvent(mojom::DubNetworkLogEntryPtr entry);

 private:
  uint64_t version_ = 0;
  std::vector<mojom::DubNetworkRulePtr> rules_;
  mojo::Remote<mojom::DubNetworkObserver> observer_;
};

}  // namespace dub
}  // namespace network

#endif  // SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_

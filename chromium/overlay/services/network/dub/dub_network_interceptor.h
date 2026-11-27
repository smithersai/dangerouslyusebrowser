// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_
#define SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_

#include <cstdint>
#include <vector>

#include "base/component_export.h"
#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/network_service.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"

namespace network {
struct ResourceRequest;
}

namespace network::dub {

class COMPONENT_EXPORT(NETWORK_SERVICE) DubNetworkInterceptor {
 public:
  using ProceedCallback = base::OnceCallback<void(
      mojo::PendingReceiver<mojom::URLLoader>,
      uint32_t,
      ResourceRequest,
      mojo::PendingRemote<mojom::URLLoaderClient>)>;

  static DubNetworkInterceptor& GetInstance();

  void SetPolicy(uint64_t version,
                 std::vector<mojom::DubNetworkRulePtr> rules,
                 mojo::PendingRemote<mojom::DubNetworkObserver> observer);

  void SetConfig(bool capture_bodies, uint32_t max_capture_bytes);

  bool HasActiveRules() const;
  bool HasObserver() const;
  bool CaptureBodies() const { return capture_bodies_; }
  uint32_t MaxCaptureBytes() const { return max_capture_bytes_; }

  void EmitEvent(mojom::DubNetworkLogEntryPtr entry);
  void InvokeObserverCallback(
      mojom::DubNetworkCallbackEventPtr event,
      base::OnceCallback<void(mojom::DubNetworkCallbackDecisionPtr)> done);

  // Intercepts an outgoing request inside the network service.
  // Returns true if handled synchronously OR deferred asynchronously via
  // `proceed` (caller must return immediately). Returns false if caller should
  // continue immediately with the (possibly rewritten) request and client.
  bool Intercept(mojo::PendingReceiver<mojom::URLLoader>& loader,
                 uint32_t& options,
                 ResourceRequest& request,
                 mojo::PendingRemote<mojom::URLLoaderClient>& client,
                 ProceedCallback proceed);

 private:
  friend class base::NoDestructor<DubNetworkInterceptor>;
  DubNetworkInterceptor();
  ~DubNetworkInterceptor();

  uint64_t version_ = 0;
  bool capture_bodies_ = false;
  uint32_t max_capture_bytes_ = 262144;
  std::vector<mojom::DubNetworkRulePtr> rules_;
  mojo::Remote<mojom::DubNetworkObserver> observer_;
};

}  // namespace network::dub

#endif  // SERVICES_NETWORK_DUB_DUB_NETWORK_INTERCEPTOR_H_

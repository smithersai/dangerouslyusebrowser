// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_EVENTS_H_
#define CHROME_BROWSER_DUB_DUB_EVENTS_H_

#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "base/files/scoped_file.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "base/values.h"

namespace dub {

// Central UI-thread hub for persistent push event streams and bounded
// browser->host callback pauses (network callbacks, JS dialogs, exposed funcs).
class DubEventHub {
 public:
  using CallbackDone =
      base::OnceCallback<void(std::optional<base::DictValue> decision)>;

  static DubEventHub& GetInstance();

  // Registers a subscribed AF_UNIX client connection. Sends the initial
  // protocol v1 subscribe ack frame and keeps the socket open for pushed frames.
  std::string AddSubscriber(base::ScopedFD fd,
                            std::string request_id,
                            std::set<std::string> event_filter);

  // Returns true if at least one stream subscriber is connected.
  bool HasSubscribers() const;

  // Broadcasts a fire-and-forget event frame to all matching subscribers.
  void EmitEvent(const std::string& event_name, base::DictValue data);

  // Registers a bounded callback pause and broadcasts a callback frame.
  // Calls `done` with the host's decision dict, or std::nullopt on timeout or
  // shutdown. Returns the generated callbackId.
  std::string InvokeCallback(const std::string& kind,
                             base::DictValue data,
                             int timeout_ms,
                             CallbackDone done);

  // Resolves a pending callback with the host's decision. Returns false if the
  // callbackId is unknown or already completed/timed out.
  bool RespondCallback(const std::string& callback_id,
                       base::DictValue decision);

  // Lists all currently pending callbacks for inspection / turn-handoff.
  base::DictValue ListPendingCallbacks() const;

  // Cancels all pending callbacks (passing std::nullopt) and closes streams.
  void Shutdown();

 private:
  friend class base::NoDestructor<DubEventHub>;
  struct Subscriber;
  struct PendingCallback;

  DubEventHub();
  ~DubEventHub();

  void SendFrameToSubscriber(Subscriber* sub, std::string payload);
  void OnSubscriberWriteDone(const std::string& stream_id, bool ok);
  void OnCallbackTimeout(const std::string& callback_id);

  uint64_t next_stream_id_ = 1;
  uint64_t next_callback_id_ = 1;
  std::vector<std::unique_ptr<Subscriber>> subscribers_;
  std::vector<std::unique_ptr<PendingCallback>> pending_callbacks_;
  base::WeakPtrFactory<DubEventHub> weak_factory_{this};
};

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_EVENTS_H_

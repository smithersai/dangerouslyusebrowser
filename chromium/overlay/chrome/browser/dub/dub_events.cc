// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_events.h"

#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <deque>
#include <memory>
#include <string>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/dub/dub_build_info.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

namespace dub {
namespace {

constexpr size_t kMaxFrameBytes = 16 * 1024 * 1024;
constexpr size_t kMaxQueuedFrames = 512;

bool WriteAll(int fd, base::span<const uint8_t> data, base::TimeTicks deadline) {
  while (!data.empty()) {
    const auto left = deadline - base::TimeTicks::Now();
    if (left <= base::TimeDelta()) {
      return false;
    }
    pollfd p{fd, POLLOUT, 0};
    const int ready = poll(&p, 1, static_cast<int>(left.InMilliseconds()));
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    if (ready <= 0 || !(p.revents & POLLOUT)) {
      return false;
    }
#ifdef MSG_NOSIGNAL
    ssize_t n = send(fd, data.data(), data.size(), MSG_NOSIGNAL);
#else
    ssize_t n = send(fd, data.data(), data.size(), 0);
#endif
    if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
      continue;
    }
    if (n <= 0) {
      return false;
    }
    data = data.subspan(static_cast<size_t>(n));
  }
  return true;
}

bool WriteFramedOnWorker(std::shared_ptr<base::ScopedFD> fd, std::string body) {
  if (!fd || !fd->is_valid() || body.empty() || body.size() > kMaxFrameBytes) {
    return false;
  }
  const auto deadline = base::TimeTicks::Now() + base::Seconds(5);
  uint32_t length = htonl(static_cast<uint32_t>(body.size()));
  return WriteAll(fd->get(), base::byte_span_from_ref(length), deadline) &&
         WriteAll(fd->get(), base::as_byte_span(body), deadline);
}

}  // namespace

struct DubEventHub::Subscriber {
  std::string id;
  std::shared_ptr<base::ScopedFD> fd;
  std::set<std::string> filter;
  scoped_refptr<base::SequencedTaskRunner> writer_runner;
  size_t in_flight = 0;
  bool dead = false;
};

struct DubEventHub::PendingCallback {
  std::string id;
  std::string kind;
  base::DictValue data;
  int64_t created_ms = 0;
  int timeout_ms = 5000;
  DubEventHub::CallbackDone done;
  base::OneShotTimer timer;
};

DubEventHub::DubEventHub() = default;
DubEventHub::~DubEventHub() = default;

DubEventHub& DubEventHub::GetInstance() {
  static base::NoDestructor<DubEventHub> instance;
  return *instance;
}

std::string DubEventHub::AddSubscriber(base::ScopedFD fd,
                                       std::string request_id,
                                       std::set<std::string> event_filter) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto sub = std::make_unique<Subscriber>();
  sub->id = "stream-" + base::NumberToString(next_stream_id_++);
  sub->fd = std::make_shared<base::ScopedFD>(std::move(fd));
  sub->filter = std::move(event_filter);
  sub->writer_runner = base::ThreadPool::CreateSequencedTaskRunner(
      {base::MayBlock(), base::TaskPriority::USER_BLOCKING});

  std::string stream_id = sub->id;

  // Send initial protocol v1 subscribe acknowledgment frame.
  base::DictValue ack;
  ack.Set("protocol", kDubProtocolVersion);
  ack.Set("id", std::move(request_id));
  base::DictValue res;
  res.Set("subscribed", true);
  res.Set("streamId", stream_id);
  ack.Set("result", std::move(res));

  std::string encoded;
  base::JSONWriter::Write(ack, &encoded);

  Subscriber* raw = sub.get();
  subscribers_.push_back(std::move(sub));
  SendFrameToSubscriber(raw, std::move(encoded));
  return stream_id;
}

bool DubEventHub::HasSubscribers() const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  for (const auto& sub : subscribers_) {
    if (!sub->dead) {
      return true;
    }
  }
  return false;
}

void DubEventHub::SendFrameToSubscriber(Subscriber* sub, std::string payload) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!sub || sub->dead || !sub->fd || !sub->fd->is_valid()) {
    return;
  }
  if (sub->in_flight >= kMaxQueuedFrames) {
    return;
  }
  ++sub->in_flight;
  const std::string stream_id = sub->id;
  sub->writer_runner->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&WriteFramedOnWorker, sub->fd, std::move(payload)),
      base::BindOnce(&DubEventHub::OnSubscriberWriteDone,
                     weak_factory_.GetWeakPtr(), stream_id));
}

void DubEventHub::OnSubscriberWriteDone(const std::string& stream_id, bool ok) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto it = std::find_if(subscribers_.begin(), subscribers_.end(),
                         [&](const auto& s) { return s->id == stream_id; });
  if (it == subscribers_.end()) {
    return;
  }
  Subscriber* sub = it->get();
  if (sub->in_flight > 0) {
    --sub->in_flight;
  }
  if (!ok) {
    sub->dead = true;
  }
  if (sub->dead && sub->in_flight == 0) {
    subscribers_.erase(it);
  }
}

void DubEventHub::EmitEvent(const std::string& event_name,
                            base::DictValue data) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (subscribers_.empty()) {
    return;
  }
  base::DictValue frame;
  frame.Set("protocol", kDubProtocolVersion);
  frame.Set("type", "event");
  frame.Set("event", event_name);
  frame.Set("data", std::move(data));
  std::string encoded;
  if (!base::JSONWriter::Write(frame, &encoded) ||
      encoded.size() > kMaxFrameBytes) {
    return;
  }
  for (auto& sub : subscribers_) {
    if (sub->dead) {
      continue;
    }
    if (!sub->filter.empty() && !sub->filter.contains(event_name) &&
        !sub->filter.contains("*")) {
      continue;
    }
    SendFrameToSubscriber(sub.get(), encoded);
  }
}

std::string DubEventHub::InvokeCallback(const std::string& kind,
                                        base::DictValue data,
                                        int timeout_ms,
                                        CallbackDone done) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const int bounded_ms = std::clamp(timeout_ms, 100, 120000);
  auto cb = std::make_unique<PendingCallback>();
  cb->id = "cb-" + base::NumberToString(next_callback_id_++);
  cb->kind = kind;
  cb->data = data.Clone();
  cb->created_ms = base::Time::Now().InMillisecondsSinceUnixEpoch();
  cb->timeout_ms = bounded_ms;
  cb->done = std::move(done);

  const std::string cb_id = cb->id;
  cb->timer.Start(FROM_HERE, base::Milliseconds(bounded_ms),
                  base::BindOnce(&DubEventHub::OnCallbackTimeout,
                                 weak_factory_.GetWeakPtr(), cb_id));
  pending_callbacks_.push_back(std::move(cb));

  if (!subscribers_.empty()) {
    base::DictValue frame;
    frame.Set("protocol", kDubProtocolVersion);
    frame.Set("type", "callback");
    frame.Set("callbackId", cb_id);
    frame.Set("kind", kind);
    frame.Set("deadlineMs", bounded_ms);
    frame.Set("data", std::move(data));
    std::string encoded;
    if (base::JSONWriter::Write(frame, &encoded) &&
        encoded.size() <= kMaxFrameBytes) {
      for (auto& sub : subscribers_) {
        if (!sub->dead) {
          SendFrameToSubscriber(sub.get(), encoded);
        }
      }
    }
  }
  return cb_id;
}

bool DubEventHub::RespondCallback(const std::string& callback_id,
                                  base::DictValue decision) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto it = std::find_if(
      pending_callbacks_.begin(), pending_callbacks_.end(),
      [&](const auto& c) { return c->id == callback_id; });
  if (it == pending_callbacks_.end()) {
    return false;
  }
  auto cb = std::move(*it);
  pending_callbacks_.erase(it);
  cb->timer.Stop();
  if (cb->done) {
    std::move(cb->done).Run(std::move(decision));
  }
  return true;
}

void DubEventHub::OnCallbackTimeout(const std::string& callback_id) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto it = std::find_if(
      pending_callbacks_.begin(), pending_callbacks_.end(),
      [&](const auto& c) { return c->id == callback_id; });
  if (it == pending_callbacks_.end()) {
    return;
  }
  auto cb = std::move(*it);
  pending_callbacks_.erase(it);
  if (cb->done) {
    std::move(cb->done).Run(std::nullopt);
  }
}

base::DictValue DubEventHub::ListPendingCallbacks() const {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  base::ListValue list;
  for (const auto& cb : pending_callbacks_) {
    base::DictValue d;
    d.Set("callbackId", cb->id);
    d.Set("kind", cb->kind);
    d.Set("createdMs", static_cast<double>(cb->created_ms));
    d.Set("timeoutMs", cb->timeout_ms);
    d.Set("data", cb->data.Clone());
    list.Append(std::move(d));
  }
  base::DictValue out;
  out.Set("callbacks", std::move(list));
  return out;
}

void DubEventHub::Shutdown() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto pending = std::move(pending_callbacks_);
  pending_callbacks_.clear();
  for (auto& cb : pending) {
    cb->timer.Stop();
    if (cb->done) {
      std::move(cb->done).Run(std::nullopt);
    }
  }
  for (auto& sub : subscribers_) {
    sub->dead = true;
    if (sub->fd && sub->fd->is_valid()) {
      shutdown(sub->fd->get(), SHUT_RDWR);
    }
  }
  subscribers_.clear();
  weak_factory_.InvalidateWeakPtrs();
}

}  // namespace dub

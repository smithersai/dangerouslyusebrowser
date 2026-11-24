// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_server.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <utility>

#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/uuid.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/dub/dub_build_info.h"
#include "chrome/browser/dub/dub_dispatch.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

namespace dub {
namespace {

constexpr size_t kMaxMessage = 16 * 1024 * 1024;
constexpr int kMaxConnections = 32;
constexpr int kDefaultTimeoutMs = 30000;
constexpr int kMaxTimeoutMs = 300000;
constexpr base::TimeDelta kReadCeiling = base::Seconds(5);

std::atomic<int> g_connections{0};

bool Transfer(int fd,
              base::span<uint8_t> data,
              bool write,
              base::TimeTicks deadline) {
  while (!data.empty()) {
    const auto left = deadline - base::TimeTicks::Now();
    if (left <= base::TimeDelta()) {
      return false;
    }
    pollfd poll_fd{fd, static_cast<short>(write ? POLLOUT : POLLIN), 0};
    const int ready =
        poll(&poll_fd, 1, static_cast<int>(left.InMilliseconds()));
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    if (ready <= 0 || !(poll_fd.revents & poll_fd.events)) {
      return false;
    }
    ssize_t n;
    if (write) {
#ifdef MSG_NOSIGNAL
      n = send(fd, data.data(), data.size(), MSG_NOSIGNAL);
#else
      n = send(fd, data.data(), data.size(), 0);
#endif
    } else {
      n = recv(fd, data.data(), data.size(), 0);
    }
    if (n < 0 &&
        (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
      continue;
    }
    if (n <= 0) {
      return false;
    }
    data = data.subspan(static_cast<size_t>(n));
  }
  return true;
}

struct Connection {
  explicit Connection(base::ScopedFD incoming) : fd(std::move(incoming)) {
    ++g_connections;
  }
  ~Connection() { --g_connections; }
  base::ScopedFD fd;
};

void WriteResponseAsync(std::unique_ptr<Connection> connection,
                        std::string id,
                        base::DictValue response,
                        base::TimeTicks deadline) {
  if (!connection || !connection->fd.is_valid()) {
    return;
  }
  response.Set("protocol", kDubProtocolVersion);
  response.Set("id", id);
  std::string encoded;
  if (!base::JSONWriter::Write(response, &encoded) ||
      encoded.size() > kMaxMessage) {
    auto error = Error("TOO_LARGE", "Dub response exceeds the 16 MiB limit");
    error.Set("protocol", kDubProtocolVersion);
    error.Set("id", id);
    if (!base::JSONWriter::Write(error, &encoded)) {
      return;
    }
  }
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(
          [](std::unique_ptr<Connection> c, std::string body,
             base::TimeTicks write_deadline) {
            const auto cap = base::TimeTicks::Now() + base::Seconds(5);
            const auto effective =
                write_deadline < cap ? write_deadline : cap;
            uint32_t length = htonl(static_cast<uint32_t>(body.size()));
            if (Transfer(c->fd.get(), base::byte_span_from_ref(length), true,
                         effective)) {
              Transfer(c->fd.get(), base::as_writable_byte_span(body), true,
                       effective);
            }
          },
          std::move(connection), std::move(encoded), deadline));
}

Profile* ResolveSelectedProfile() {
  if (auto* profile = ProfileManager::GetLastUsedProfileIfLoaded()) {
    if (!profile->IsOffTheRecord()) {
      return profile;
    }
  }
  if (auto* windows = GlobalBrowserCollection::GetInstance()) {
    if (auto* window = windows->GetLastActiveBrowser()) {
      if (auto* profile = window->GetProfile();
          profile && !profile->IsOffTheRecord()) {
        return profile;
      }
    }
  }
  if (g_browser_process && g_browser_process->profile_manager()) {
    for (Profile* profile :
         g_browser_process->profile_manager()->GetLoadedProfiles()) {
      if (profile && !profile->IsOffTheRecord()) {
        return profile;
      }
    }
  }
  return nullptr;
}

class Server {
 public:
  void Start() {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    const auto path =
        base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
            "dub-socket");
    if (path.empty() || started_) {
      return;
    }
    Profile* profile = ResolveSelectedProfile();
    if (!profile) {
      LOG(ERROR) << "Dub could not resolve an initial regular profile";
      return;
    }

    stopping_ = false;
    instance_id_ = base::Uuid::GenerateRandomV4().AsLowercaseString();
    selected_profile_ = profile->GetWeakPtr();
    selected_profile_path_ = profile->GetPath().value();
    browser_keep_alive_ = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::DUB_SERVER, KeepAliveRestartOption::DISABLED);
    profile_keep_alive_ = ScopedProfileKeepAlive::TryAcquire(
        profile, ProfileKeepAliveOrigin::kDubServer);
    if (!profile_keep_alive_) {
      LOG(WARNING) << "Dub could not acquire profile keepalive for "
                   << selected_profile_path_;
    }

    if (!thread_.Start()) {
      LOG(ERROR) << "Dub could not start its listener thread";
      profile_keep_alive_.reset();
      browser_keep_alive_.reset();
      return;
    }
    started_ = true;
    thread_.task_runner()->PostTask(
        FROM_HERE,
        base::BindOnce(&Server::Accept, base::Unretained(this), path.value()));
  }

  void Stop() {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    if (!started_) {
      return;
    }
    stopping_ = true;

    // Invalidate all pending UI requests and close their connections before
    // profile/browser teardown without waiting for ThreadPool tasks.
    auto pending = std::move(pending_requests_);
    pending_requests_.clear();
    for (auto& [token, entry] : pending) {
      entry->timer.Stop();
      if (entry->cancel) {
        std::move(entry->cancel).Run();
      }
      entry->connection.reset();
    }
    weak_factory_.InvalidateWeakPtrs();

    profile_keep_alive_.reset();
    browser_keep_alive_.reset();
    selected_profile_.reset();

    thread_.Stop();
    started_ = false;
  }

 private:
  struct PendingRequest {
    PendingRequest(std::unique_ptr<Connection> conn,
                   std::string req_id,
                   base::TimeTicks req_deadline)
        : connection(std::move(conn)),
          id(std::move(req_id)),
          deadline(req_deadline) {}
    std::unique_ptr<Connection> connection;
    std::string id;
    base::TimeTicks deadline;
    base::OneShotTimer timer;
    base::OnceClosure cancel;
  };

  void HandleDecodedRequestOnUI(std::unique_ptr<Connection> connection,
                                std::string request_id,
                                base::DictValue request,
                                base::TimeTicks deadline) {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    if (stopping_ || !started_) {
      WriteResponseAsync(std::move(connection), std::move(request_id),
                         Error("SHUTTING_DOWN", "Dub browser is shutting down"),
                         base::TimeTicks::Now() + base::Milliseconds(250));
      return;
    }

    const base::TimeDelta remaining = deadline - base::TimeTicks::Now();
    if (remaining <= base::TimeDelta()) {
      WriteResponseAsync(std::move(connection), std::move(request_id),
                         Error("TIMEOUT", "Dub native request timed out"),
                         base::TimeTicks::Now() + base::Milliseconds(250));
      return;
    }

    const uint64_t token = ++next_request_token_;
    auto entry = std::make_unique<PendingRequest>(std::move(connection),
                                                  request_id, deadline);
    auto* raw_entry = entry.get();
    pending_requests_.emplace(token, std::move(entry));

    raw_entry->timer.Start(
        FROM_HERE, remaining,
        base::BindOnce(&Server::OnRequestTimeoutOnUI,
                       weak_factory_.GetWeakPtr(), token));

    SessionContext session;
    session.profile = selected_profile_;
    session.profile_path = selected_profile_path_;
    session.instance_id = instance_id_;
    session.next_task_id = base::BindRepeating(
        [](std::atomic<uint32_t>* counter) { return counter->fetch_add(1); },
        base::Unretained(&next_task_id_));

    Dispatch(session, std::move(request),
             base::BindOnce(&Server::CompleteRequestOnUI,
                            weak_factory_.GetWeakPtr(), token),
             base::BindOnce(&Server::SetCancelOnUI, weak_factory_.GetWeakPtr(),
                            token));
  }

  void SetCancelOnUI(uint64_t token, base::OnceClosure cancel) {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    auto it = pending_requests_.find(token);
    if (it != pending_requests_.end()) {
      it->second->cancel = std::move(cancel);
    }
  }

  void CompleteRequestOnUI(uint64_t token, base::DictValue response) {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    auto it = pending_requests_.find(token);
    if (it == pending_requests_.end()) {
      return;
    }
    auto entry = std::move(it->second);
    pending_requests_.erase(it);
    entry->timer.Stop();
    entry->cancel.Reset();
    WriteResponseAsync(std::move(entry->connection), std::move(entry->id),
                       std::move(response), entry->deadline);
  }

  void OnRequestTimeoutOnUI(uint64_t token) {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    auto it = pending_requests_.find(token);
    if (it == pending_requests_.end()) {
      return;
    }
    auto entry = std::move(it->second);
    pending_requests_.erase(it);
    if (entry->cancel) {
      std::move(entry->cancel).Run();
    }
    WriteResponseAsync(std::move(entry->connection), std::move(entry->id),
                       Error("TIMEOUT", "Dub native request timed out"),
                       base::TimeTicks::Now() + base::Milliseconds(250));
  }

  void Read(std::unique_ptr<Connection> connection,
            base::TimeTicks accepted_at) {
    uint32_t length = 0;
    const auto read_deadline = accepted_at + kReadCeiling;
    if (!Transfer(connection->fd.get(), base::byte_span_from_ref(length), false,
                  read_deadline)) {
      return;
    }
    const size_t size = ntohl(length);
    if (size == 0 || size > kMaxMessage) {
      return;
    }
    std::string body(size, '\0');
    if (!Transfer(connection->fd.get(), base::as_writable_byte_span(body), false,
                  read_deadline)) {
      return;
    }
    auto request = base::JSONReader::ReadDict(body, base::JSON_PARSE_RFC);
    if (!request) {
      WriteResponseAsync(std::move(connection), "",
                         Error("INVALID_REQUEST", "Expected a JSON object"),
                         base::TimeTicks::Now() + base::Seconds(1));
      return;
    }
    const std::string* id = request->FindString("id");
    if (!id || id->size() > 128 ||
        request->FindInt("protocol") != kDubProtocolVersion ||
        !request->FindString("method") || !request->FindDict("params")) {
      WriteResponseAsync(
          std::move(connection), id ? *id : "",
          Error("INVALID_REQUEST",
                "Expected protocol 1, string id/method and object params"),
          base::TimeTicks::Now() + base::Seconds(1));
      return;
    }

    int timeout_ms = kDefaultTimeoutMs;
    if (const base::Value* raw_timeout = request->Find("timeoutMs")) {
      if (!raw_timeout->is_int() || raw_timeout->GetInt() < 1 ||
          raw_timeout->GetInt() > kMaxTimeoutMs) {
        WriteResponseAsync(
            std::move(connection), *id,
            Error("INVALID_REQUEST", "timeoutMs must be an integer 1-300000"),
            base::TimeTicks::Now() + base::Seconds(1));
        return;
      }
      timeout_ms = raw_timeout->GetInt();
    }

    std::string request_id = *id;
    const base::TimeTicks deadline =
        accepted_at + base::Milliseconds(timeout_ms);
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE,
        base::BindOnce(&Server::HandleDecodedRequestOnUI,
                       base::Unretained(this), std::move(connection),
                       std::move(request_id), std::move(*request), deadline));
  }

  void UnlinkIfOwned(const std::string& path, dev_t dev, ino_t ino) {
    struct stat current {};
    if (lstat(path.c_str(), &current) == 0 && S_ISSOCK(current.st_mode) &&
        current.st_dev == dev && current.st_ino == ino) {
      unlink(path.c_str());
    }
  }

  void Accept(std::string path) {
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (path.empty() || path.size() >= sizeof(address.sun_path)) {
      LOG(ERROR) << "Invalid Dub socket path";
      return;
    }
    const auto slash = path.rfind('/');
    if (slash == std::string::npos) {
      return;
    }
    struct stat parent {};
    if (lstat(path.substr(0, slash).c_str(), &parent) != 0 ||
        !S_ISDIR(parent.st_mode) || parent.st_uid != getuid() ||
        (parent.st_mode & 077) != 0) {
      LOG(ERROR) << "Dub socket parent must be an owned 0700 directory";
      return;
    }
    base::as_writable_byte_span(address.sun_path)
        .copy_prefix_from(base::as_byte_span(path));
    base::ScopedFD listener(socket(AF_UNIX, SOCK_STREAM, 0));
    if (!listener.is_valid()) {
      return;
    }
    if (fcntl(listener.get(), F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(listener.get(), F_SETFL, O_NONBLOCK) < 0) {
      return;
    }
    // Never remove an existing path. The launcher diagnoses live/stale sockets.
    if (bind(listener.get(), reinterpret_cast<sockaddr*>(&address),
             sizeof(address)) != 0) {
      PLOG(ERROR) << "Dub socket bind failed";
      return;
    }
    struct stat bound {};
    if (lstat(path.c_str(), &bound) != 0) {
      return;
    }
    if (chmod(path.c_str(), 0600) != 0 ||
        listen(listener.get(), kMaxConnections) != 0) {
      UnlinkIfOwned(path, bound.st_dev, bound.st_ino);
      return;
    }
    while (!stopping_) {
      pollfd p{listener.get(), POLLIN, 0};
      if (poll(&p, 1, 100) <= 0) {
        continue;
      }
      base::ScopedFD fd(accept(listener.get(), nullptr, nullptr));
      if (!fd.is_valid()) {
        continue;
      }
      if (g_connections.load() >= kMaxConnections) {
        continue;
      }
      if (fcntl(fd.get(), F_SETFD, FD_CLOEXEC) < 0 ||
          fcntl(fd.get(), F_SETFL, O_NONBLOCK) < 0) {
        continue;
      }
#ifdef SO_NOSIGPIPE
      int enabled = 1;
      if (setsockopt(fd.get(), SOL_SOCKET, SO_NOSIGPIPE, &enabled,
                     sizeof(enabled)) < 0) {
        continue;
      }
#endif
      const auto accepted_at = base::TimeTicks::Now();
      base::ThreadPool::PostTask(
          FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
          base::BindOnce(&Server::Read, base::Unretained(this),
                         std::make_unique<Connection>(std::move(fd)),
                         accepted_at));
    }
    UnlinkIfOwned(path, bound.st_dev, bound.st_ino);
  }

  bool started_ = false;
  std::atomic<bool> stopping_{false};
  std::atomic<uint32_t> next_task_id_{1};
  uint64_t next_request_token_ = 0;
  std::string instance_id_;
  std::string selected_profile_path_;
  base::WeakPtr<Profile> selected_profile_;
  std::unique_ptr<ScopedKeepAlive> browser_keep_alive_;
  std::unique_ptr<ScopedProfileKeepAlive> profile_keep_alive_;
  std::map<uint64_t, std::unique_ptr<PendingRequest>> pending_requests_;
  base::Thread thread_{"DubListener"};
  base::WeakPtrFactory<Server> weak_factory_{this};
};

Server& Instance() {
  static base::NoDestructor<Server> server;
  return *server;
}

}  // namespace

void StartServer() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Instance().Start();
}

void StopServer() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  Instance().Stop();
}

}  // namespace dub

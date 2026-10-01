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
#include <cstring>
#include <memory>
#include <string>

#include "base/command_line.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "chrome/browser/dub/dub_dispatch.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

namespace dub {
namespace {
constexpr size_t kMaxMessage = 16 * 1024 * 1024;
constexpr int kMaxConnections = 32;
std::atomic<int> g_connections{0};

bool Transfer(int fd, void* data, size_t size, bool write,
              base::TimeTicks deadline) {
  auto* p = static_cast<char*>(data);
  while (size > 0) {
    auto left = deadline - base::TimeTicks::Now();
    if (left <= base::TimeDelta()) return false;
    pollfd poll_fd{fd, static_cast<short>(write ? POLLOUT : POLLIN), 0};
    int ready = poll(&poll_fd, 1, static_cast<int>(left.InMilliseconds()));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || !(poll_fd.revents & poll_fd.events)) return false;
    ssize_t n;
    if (write) {
#ifdef MSG_NOSIGNAL
      n = send(fd, p, size, MSG_NOSIGNAL);
#else
      n = send(fd, p, size, 0);
#endif
    } else n = recv(fd, p, size, 0);
    if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (n <= 0) return false;
    p += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

struct Connection {
  explicit Connection(base::ScopedFD incoming) : fd(std::move(incoming)) { ++g_connections; }
  ~Connection() { --g_connections; }
  base::ScopedFD fd;
};

void Send(std::unique_ptr<Connection> connection, std::string id,
          base::DictValue response) {
  response.Set("protocol", 1);
  response.Set("id", id);
  std::string encoded;
  if (!base::JSONWriter::Write(response, &encoded) || encoded.size() > kMaxMessage) {
    auto error = Error("TOO_LARGE", "Dub response exceeds the 16 MiB limit");
    error.Set("protocol", 1).Set("id", id);
    if (!base::JSONWriter::Write(error, &encoded)) return;
  }
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce([](std::unique_ptr<Connection> c, std::string body) {
        uint32_t length = htonl(static_cast<uint32_t>(body.size()));
        const auto deadline = base::TimeTicks::Now() + base::Seconds(5);
        if (Transfer(c->fd.get(), &length, sizeof(length), true, deadline))
          Transfer(c->fd.get(), body.data(), body.size(), true, deadline);
      }, std::move(connection), std::move(encoded)));
}

void Read(std::unique_ptr<Connection> connection) {
  uint32_t length = 0;
  const auto deadline = base::TimeTicks::Now() + base::Seconds(5);
  if (!Transfer(connection->fd.get(), &length, sizeof(length), false, deadline)) return;
  const size_t size = ntohl(length);
  if (size == 0 || size > kMaxMessage) return;
  std::string body(size, '\0');
  if (!Transfer(connection->fd.get(), body.data(), size, false, deadline)) return;
  auto request = base::JSONReader::ReadDict(body, base::JSON_PARSE_RFC);
  if (!request) { Send(std::move(connection), "", Error("INVALID_REQUEST", "Expected a JSON object")); return; }
  const std::string* id = request->FindString("id");
  if (!id || id->size() > 128 || request->FindInt("protocol") != 1 ||
      !request->FindString("method") || !request->FindDict("params")) {
    Send(std::move(connection), id ? *id : "", Error("INVALID_REQUEST", "Expected protocol 1, string id/method and object params"));
    return;
  }
  std::string request_id = *id;
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&Dispatch, std::move(*request),
                               base::BindOnce(&Send, std::move(connection), std::move(request_id))));
}

class Server {
 public:
  void Start() {
    const auto path = base::CommandLine::ForCurrentProcess()->GetSwitchValuePath("dub-socket");
    if (path.empty() || started_) return;
    stopped_ = false;
    if (!thread_.Start()) { LOG(ERROR) << "Dub could not start its listener thread"; return; }
    started_ = true;
    thread_.task_runner()->PostTask(FROM_HERE, base::BindOnce(&Server::Accept, base::Unretained(this), path.value()));
  }
  void Stop() {
    if (!started_) return;
    stopped_ = true;
    thread_.Stop();
    started_ = false;
  }
 private:
  void Accept(std::string path) {
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (path.empty() || path.size() >= sizeof(address.sun_path)) { LOG(ERROR) << "Invalid Dub socket path"; return; }
    const auto slash = path.rfind('/');
    if (slash == std::string::npos) return;
    struct stat parent{};
    if (lstat(path.substr(0, slash).c_str(), &parent) != 0 || !S_ISDIR(parent.st_mode) ||
        parent.st_uid != getuid() || (parent.st_mode & 077) != 0) {
      LOG(ERROR) << "Dub socket parent must be an owned 0700 directory";
      return;
    }
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    base::ScopedFD listener(socket(AF_UNIX, SOCK_STREAM, 0));
    if (!listener.is_valid()) return;
    if (fcntl(listener.get(), F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(listener.get(), F_SETFL, O_NONBLOCK) < 0) return;
    // Never remove an existing path. The launcher diagnoses live/stale sockets.
    if (bind(listener.get(), reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      PLOG(ERROR) << "Dub socket bind failed"; return;
    }
    if (chmod(path.c_str(), 0600) != 0 || listen(listener.get(), kMaxConnections) != 0) {
      unlink(path.c_str()); return;
    }
    while (!stopped_) {
      pollfd p{listener.get(), POLLIN, 0};
      if (poll(&p, 1, 200) <= 0) continue;
      base::ScopedFD fd(accept(listener.get(), nullptr, nullptr));
      if (!fd.is_valid() || g_connections >= kMaxConnections) continue;
      if (fcntl(fd.get(), F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd.get(), F_SETFL, O_NONBLOCK) < 0) continue;
#ifdef SO_NOSIGPIPE
      int enabled = 1;
      if (setsockopt(fd.get(), SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) < 0) continue;
#endif
      base::ThreadPool::PostTask(FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
          base::BindOnce(&Read, std::make_unique<Connection>(std::move(fd))));
    }
    unlink(path.c_str());
  }
  bool started_ = false;
  std::atomic<bool> stopped_{false};
  base::Thread thread_{"DubListener"};
};
Server& Instance() { static base::NoDestructor<Server> server; return *server; }
}
void StartServer() { DCHECK_CURRENTLY_ON(content::BrowserThread::UI); Instance().Start(); }
void StopServer() { DCHECK_CURRENTLY_ON(content::BrowserThread::UI); Instance().Stop(); }
}

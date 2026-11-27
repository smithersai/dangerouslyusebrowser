#include "dub.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>

struct dub_stream {
  int fd = -1;
  int wake_read = -1;
  int wake_write = -1;
  std::atomic<bool> cancelled{false};
};

namespace {
constexpr size_t kMaxMessage = 16 * 1024 * 1024;
using Clock = std::chrono::steady_clock;
struct Socket {
  int fd = -1;
  ~Socket() { if (fd >= 0) close(fd); }
  int release() { int out = fd; fd = -1; return out; }
};
bool Wait(int fd, short events, Clock::time_point deadline, std::string& error) {
  for (;;) {
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (left <= 0) { error = "Dub native request timed out"; return false; }
    pollfd p{fd, events, 0};
    const int ready = poll(&p, 1, static_cast<int>(left));
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) { error = std::strerror(errno); return false; }
    if (ready == 0) { error = "Dub native request timed out"; return false; }
    if (p.revents & events) return true;
    error = "Dub browser closed the connection";
    return false;
  }
}
bool Transfer(int fd, void* bytes, size_t size, bool write, Clock::time_point deadline, std::string& error) {
  char* cursor = static_cast<char*>(bytes);
  while (size) {
    if (!Wait(fd, write ? POLLOUT : POLLIN, deadline, error)) return false;
    ssize_t n;
    if (write) {
#ifdef MSG_NOSIGNAL
      n = send(fd, cursor, size, MSG_NOSIGNAL);
#else
      n = send(fd, cursor, size, 0);
#endif
    } else n = recv(fd, cursor, size, 0);
    if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (n <= 0) { error = n == 0 ? "Dub browser closed the connection" : std::strerror(errno); return false; }
    cursor += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

int ConnectAndExchange(const char* path, const char* request, size_t request_size,
                       unsigned timeout_ms, Socket& out_socket,
                       char** output, size_t* output_size, std::string& problem) {
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (!path || !*path || strlen(path) >= sizeof(addr.sun_path)) { problem = "Invalid Dub socket path"; return -1; }
  if (!request || request_size == 0 || request_size > kMaxMessage) { problem = "Dub request must be 1 byte to 16 MiB"; return -1; }
  if (timeout_ms == 0 || timeout_ms > 300000) { problem = "Dub timeout must be between 1 and 300000 ms"; return -1; }
  memcpy(addr.sun_path, path, strlen(path) + 1);
  Socket socket{::socket(AF_UNIX, SOCK_STREAM, 0)};
  if (socket.fd < 0) { problem = std::strerror(errno); return -1; }
  if (fcntl(socket.fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(socket.fd, F_SETFL, O_NONBLOCK) < 0) { problem = std::strerror(errno); return -1; }
#ifdef SO_NOSIGPIPE
  int enabled = 1;
  if (setsockopt(socket.fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) < 0) { problem = std::strerror(errno); return -1; }
#endif
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  if (connect(socket.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    if (errno != EINPROGRESS && errno != EAGAIN) { problem = std::string("Cannot connect to Dub browser: ") + std::strerror(errno); return -1; }
    if (!Wait(socket.fd, POLLOUT, deadline, problem)) return -1;
    int status = 0; socklen_t length = sizeof(status);
    if (getsockopt(socket.fd, SOL_SOCKET, SO_ERROR, &status, &length) < 0) { problem = std::strerror(errno); return -1; }
    if (status != 0) { problem = std::strerror(status); return -1; }
  }
  uint32_t length = htonl(static_cast<uint32_t>(request_size));
  if (!Transfer(socket.fd, &length, sizeof(length), true, deadline, problem) ||
      !Transfer(socket.fd, const_cast<char*>(request), request_size, true, deadline, problem) ||
      !Transfer(socket.fd, &length, sizeof(length), false, deadline, problem)) return -1;
  const size_t response_size = ntohl(length);
  if (response_size == 0 || response_size > kMaxMessage) { problem = "Invalid Dub response length"; return -1; }
  char* response = static_cast<char*>(malloc(response_size + 1));
  if (!response) { problem = "Out of memory reading Dub response"; return -1; }
  if (!Transfer(socket.fd, response, response_size, false, deadline, problem)) { free(response); return -1; }
  response[response_size] = 0;
  *output = response; *output_size = response_size;
  out_socket.fd = socket.release();
  return 0;
}

int StreamReadExact(dub_stream_t* stream, void* bytes, size_t size, std::string& error) {
  char* cursor = static_cast<char*>(bytes);
  bool started = false;
  while (size > 0) {
    if (stream->cancelled.load()) return 1;
    pollfd fds[2]{
      {stream->fd, POLLIN, 0},
      {stream->wake_read, POLLIN, 0},
    };
    const int ready = poll(fds, 2, 1000);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) { error = std::strerror(errno); return -1; }
    if (ready == 0) continue;
    if (stream->cancelled.load() || (fds[1].revents & POLLIN)) return 1;
    if (fds[0].revents & POLLIN) {
      ssize_t n = recv(stream->fd, cursor, size, 0);
      if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
      if (n == 0) {
        if (!started) return 1;
        error = "Dub event stream truncated";
        return -1;
      }
      if (n < 0) { error = std::strerror(errno); return -1; }
      started = true;
      cursor += n;
      size -= static_cast<size_t>(n);
      continue;
    }
    if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) {
      if (!started) return 1;
      error = "Dub event stream closed";
      return -1;
    }
  }
  return 0;
}
}

int dub_call(const char* path, const char* request, size_t request_size,
             unsigned timeout_ms, char** output, size_t* output_size, char** error) {
  if (!output || !output_size || !error) return -1;
  *output = nullptr; *output_size = 0; *error = nullptr;
  Socket sock;
  std::string problem;
  if (ConnectAndExchange(path, request, request_size, timeout_ms, sock, output, output_size, problem) != 0) {
    *error = strdup(problem.c_str());
    return -1;
  }
  return 0;
}

int dub_stream_open(const char* socket_path, const char* request, size_t request_size,
                    unsigned timeout_ms, dub_stream_t** out_stream,
                    char** ack, size_t* ack_size, char** error) {
  if (!out_stream || !ack || !ack_size || !error) return -1;
  *out_stream = nullptr; *ack = nullptr; *ack_size = 0; *error = nullptr;
  Socket sock;
  std::string problem;
  if (ConnectAndExchange(socket_path, request, request_size, timeout_ms, sock, ack, ack_size, problem) != 0) {
    *error = strdup(problem.c_str());
    return -1;
  }
  int pipes[2]{-1, -1};
  if (pipe(pipes) != 0) {
    free(*ack); *ack = nullptr; *ack_size = 0;
    *error = strdup(std::strerror(errno));
    return -1;
  }
  fcntl(pipes[0], F_SETFD, FD_CLOEXEC);
  fcntl(pipes[1], F_SETFD, FD_CLOEXEC);
  fcntl(pipes[0], F_SETFL, O_NONBLOCK);
  fcntl(pipes[1], F_SETFL, O_NONBLOCK);
  auto* stream = new dub_stream();
  stream->fd = sock.release();
  stream->wake_read = pipes[0];
  stream->wake_write = pipes[1];
  *out_stream = stream;
  return 0;
}

int dub_stream_read(dub_stream_t* stream, char** output, size_t* output_size, char** error) {
  if (!stream || !output || !output_size || !error) return -1;
  *output = nullptr; *output_size = 0; *error = nullptr;
  uint32_t length = 0;
  std::string problem;
  int rc = StreamReadExact(stream, &length, sizeof(length), problem);
  if (rc != 0) {
    if (rc < 0) *error = strdup(problem.c_str());
    return rc;
  }
  const size_t msg_size = ntohl(length);
  if (msg_size == 0 || msg_size > kMaxMessage) {
    *error = strdup("Invalid Dub stream frame length");
    return -1;
  }
  char* buf = static_cast<char*>(malloc(msg_size + 1));
  if (!buf) {
    *error = strdup("Out of memory reading Dub stream frame");
    return -1;
  }
  rc = StreamReadExact(stream, buf, msg_size, problem);
  if (rc != 0) {
    free(buf);
    if (rc < 0) *error = strdup(problem.c_str());
    return rc;
  }
  buf[msg_size] = 0;
  *output = buf;
  *output_size = msg_size;
  return 0;
}

void dub_stream_cancel(dub_stream_t* stream) {
  if (!stream) return;
  stream->cancelled.store(true);
  if (stream->wake_write >= 0) {
    char b = 1;
    ssize_t ignored = write(stream->wake_write, &b, 1);
    (void)ignored;
  }
}

void dub_stream_close(dub_stream_t* stream) {
  if (!stream) return;
  if (stream->fd >= 0) close(stream->fd);
  if (stream->wake_read >= 0) close(stream->wake_read);
  if (stream->wake_write >= 0) close(stream->wake_write);
  delete stream;
}

void dub_free(void* memory) { free(memory); }

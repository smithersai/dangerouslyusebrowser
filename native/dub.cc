#include "dub.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>

namespace {
constexpr size_t kMaxMessage = 16 * 1024 * 1024;
using Clock = std::chrono::steady_clock;
struct Socket {
  int fd = -1;
  ~Socket() { if (fd >= 0) close(fd); }
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
}

int dub_call(const char* path, const char* request, size_t request_size,
             unsigned timeout_ms, char** output, size_t* output_size, char** error) {
  if (!output || !output_size || !error) return -1;
  *output = nullptr; *output_size = 0; *error = nullptr;
  std::string problem;
  auto fail = [&](const std::string& message) { *error = strdup(message.c_str()); return -1; };
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (!path || !*path || strlen(path) >= sizeof(addr.sun_path)) return fail("Invalid Dub socket path");
  if (!request || request_size == 0 || request_size > kMaxMessage) return fail("Dub request must be 1 byte to 16 MiB");
  if (timeout_ms == 0 || timeout_ms > 300000) return fail("Dub timeout must be between 1 and 300000 ms");
  memcpy(addr.sun_path, path, strlen(path) + 1);
  Socket socket{::socket(AF_UNIX, SOCK_STREAM, 0)};
  if (socket.fd < 0) return fail(std::strerror(errno));
  if (fcntl(socket.fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(socket.fd, F_SETFL, O_NONBLOCK) < 0) return fail(std::strerror(errno));
#ifdef SO_NOSIGPIPE
  int enabled = 1;
  if (setsockopt(socket.fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) < 0) return fail(std::strerror(errno));
#endif
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  if (connect(socket.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
    if (errno != EINPROGRESS && errno != EAGAIN) return fail(std::string("Cannot connect to Dub browser: ") + std::strerror(errno));
    if (!Wait(socket.fd, POLLOUT, deadline, problem)) return fail(problem);
    int status = 0; socklen_t length = sizeof(status);
    if (getsockopt(socket.fd, SOL_SOCKET, SO_ERROR, &status, &length) < 0) return fail(std::strerror(errno));
    if (status != 0) return fail(std::strerror(status));
  }
  uint32_t length = htonl(static_cast<uint32_t>(request_size));
  if (!Transfer(socket.fd, &length, sizeof(length), true, deadline, problem) ||
      !Transfer(socket.fd, const_cast<char*>(request), request_size, true, deadline, problem) ||
      !Transfer(socket.fd, &length, sizeof(length), false, deadline, problem)) return fail(problem);
  const size_t response_size = ntohl(length);
  if (response_size == 0 || response_size > kMaxMessage) return fail("Invalid Dub response length");
  char* response = static_cast<char*>(malloc(response_size + 1));
  if (!response) return fail("Out of memory reading Dub response");
  if (!Transfer(socket.fd, response, response_size, false, deadline, problem)) { free(response); return fail(problem); }
  response[response_size] = 0;
  *output = response; *output_size = response_size;
  return 0;
}
void dub_free(void* memory) { free(memory); }

#include <node_api.h>
#include <cmath>
#include <memory>
#include <string>
#include "dub.h"

namespace {
struct Call {
  napi_async_work work{};
  napi_deferred deferred{};
  std::string path;
  std::string request;
  unsigned timeout = 30000;
  char* output = nullptr;
  size_t size = 0;
  char* error = nullptr;
  ~Call() { dub_free(output); dub_free(error); }
};
bool ReadString(napi_env env, napi_value value, std::string& out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t size;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 16 * 1024 * 1024) return false;
  out.resize(size + 1);
  if (napi_get_value_string_utf8(env, value, out.data(), out.size(), &size) != napi_ok) return false;
  out.resize(size);
  return out.find('\0') == std::string::npos;
}
void Execute(napi_env, void* data) {
  auto& c = *static_cast<Call*>(data);
  dub_call(c.path.c_str(), c.request.data(), c.request.size(), c.timeout, &c.output, &c.size, &c.error);
}
void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Call> c(static_cast<Call*>(data));
  napi_value value;
  if (status != napi_ok || c->error || !c->output) {
    const char* message = c->error ? c->error : "Dub native request cancelled";
    napi_value text;
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
    napi_create_error(env, nullptr, text, &value);
    napi_reject_deferred(env, c->deferred, value);
  } else {
    napi_create_string_utf8(env, c->output, c->size, &value);
    napi_resolve_deferred(env, c->deferred, value);
  }
  napi_delete_async_work(env, c->work);
}
napi_value Request(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto call = std::make_unique<Call>();
  if (argc < 2 || !ReadString(env, argv[0], call->path) || !ReadString(env, argv[1], call->request)) {
    napi_throw_type_error(env, nullptr, "request(socketPath, json, timeoutMs) requires strings without NUL bytes (max 16 MiB)"); return nullptr;
  }
  if (argc == 3) {
    double timeout;
    if (napi_get_value_double(env, argv[2], &timeout) != napi_ok || !std::isfinite(timeout) || timeout < 1 || timeout > 300000 || std::floor(timeout) != timeout) {
      napi_throw_range_error(env, nullptr, "timeoutMs must be an integer between 1 and 300000"); return nullptr;
    }
    call->timeout = static_cast<unsigned>(timeout);
  }
  napi_value promise, name;
  if (napi_create_promise(env, &call->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "dub.request", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, Execute, Complete, call.get(), &call->work) != napi_ok) {
    napi_throw_error(env, nullptr, "Cannot create Dub native work"); return nullptr;
  }
  if (napi_queue_async_work(env, call->work) != napi_ok) {
    napi_delete_async_work(env, call->work);
    napi_throw_error(env, nullptr, "Cannot queue Dub native work"); return nullptr;
  }
  call.release();
  return promise;
}
napi_value Init(napi_env env, napi_value exports) {
  napi_value request;
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, Request, nullptr, &request);
  napi_set_named_property(env, exports, "request", request);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

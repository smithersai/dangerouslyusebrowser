#include <node_api.h>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <thread>
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

struct StreamEventPayload {
  bool closed = false;
  std::string message;
  std::string error;
};

struct StreamHandle {
  dub_stream_t* stream = nullptr;
  std::thread reader;
  std::atomic<bool> closed{false};

  void Stop() {
    if (closed.exchange(true)) return;
    if (stream) dub_stream_cancel(stream);
    if (reader.joinable()) reader.join();
    if (stream) {
      dub_stream_close(stream);
      stream = nullptr;
    }
  }
  ~StreamHandle() { Stop(); }
};

void CallJsStreamCallback(napi_env env, napi_value js_cb, void*, void* data) {
  std::unique_ptr<StreamEventPayload> payload(static_cast<StreamEventPayload*>(data));
  if (!env || !js_cb) return;
  napi_value undefined, kind, text;
  napi_get_undefined(env, &undefined);
  if (payload->closed) {
    napi_create_string_utf8(env, payload->error.empty() ? "close" : "error", NAPI_AUTO_LENGTH, &kind);
    napi_create_string_utf8(env, payload->error.c_str(), payload->error.size(), &text);
  } else {
    napi_create_string_utf8(env, "message", NAPI_AUTO_LENGTH, &kind);
    napi_create_string_utf8(env, payload->message.c_str(), payload->message.size(), &text);
  }
  napi_value args[2] = {kind, text};
  napi_call_function(env, undefined, js_cb, 2, args, nullptr);
}

void FinalizeStreamHandle(napi_env, void* data, void*) {
  delete static_cast<StreamHandle*>(data);
}

napi_value CloseStream(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  if (auto* handle = static_cast<StreamHandle*>(data)) {
    handle->Stop();
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

struct SubscribeWork {
  napi_async_work work{};
  napi_deferred deferred{};
  napi_threadsafe_function tsfn = nullptr;
  std::string path;
  std::string request;
  unsigned timeout = 10000;
  dub_stream_t* stream = nullptr;
  char* ack = nullptr;
  size_t ack_size = 0;
  char* error = nullptr;
  ~SubscribeWork() {
    dub_free(ack);
    dub_free(error);
    if (stream) dub_stream_close(stream);
    if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
  }
};

void ExecuteSubscribe(napi_env, void* data) {
  auto& w = *static_cast<SubscribeWork*>(data);
  dub_stream_open(w.path.c_str(), w.request.data(), w.request.size(), w.timeout,
                  &w.stream, &w.ack, &w.ack_size, &w.error);
}

void CompleteSubscribe(napi_env env, napi_status status, void* data) {
  std::unique_ptr<SubscribeWork> w(static_cast<SubscribeWork*>(data));
  napi_delete_async_work(env, w->work);
  if (status != napi_ok || w->error || !w->stream) {
    const char* msg = w->error ? w->error : "Failed to open Dub stream";
    napi_value text, err;
    napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &text);
    napi_create_error(env, nullptr, text, &err);
    napi_reject_deferred(env, w->deferred, err);
    return;
  }

  auto handle = std::make_unique<StreamHandle>();
  handle->stream = w->stream;
  w->stream = nullptr;
  napi_threadsafe_function tsfn = w->tsfn;
  w->tsfn = nullptr;

  StreamHandle* raw = handle.get();
  raw->reader = std::thread([raw, tsfn]() {
    for (;;) {
      char* msg = nullptr;
      size_t msg_size = 0;
      char* read_err = nullptr;
      const int rc = dub_stream_read(raw->stream, &msg, &msg_size, &read_err);
      if (rc == 0 && msg) {
        auto* payload = new StreamEventPayload();
        payload->message.assign(msg, msg_size);
        dub_free(msg);
        if (napi_call_threadsafe_function(tsfn, payload, napi_tsfn_blocking) != napi_ok) {
          delete payload;
          break;
        }
        continue;
      }
      if (!raw->closed.load()) {
        auto* payload = new StreamEventPayload();
        payload->closed = true;
        if (rc < 0 && read_err) payload->error = read_err;
        if (napi_call_threadsafe_function(tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
          delete payload;
        }
      }
      dub_free(read_err);
      break;
    }
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  });

  napi_value result, ack_val, close_fn;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, w->ack ? w->ack : "", w->ack_size, &ack_val);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseStream, raw, &close_fn);
  napi_set_named_property(env, result, "ack", ack_val);
  napi_set_named_property(env, result, "close", close_fn);
  napi_wrap(env, result, handle.release(), FinalizeStreamHandle, nullptr, nullptr);
  napi_resolve_deferred(env, w->deferred, result);
}

napi_value Subscribe(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto w = std::make_unique<SubscribeWork>();
  if (argc < 4 || !ReadString(env, argv[0], w->path) || !ReadString(env, argv[1], w->request)) {
    napi_throw_type_error(env, nullptr, "subscribe(socketPath, json, timeoutMs, callback) requires valid arguments");
    return nullptr;
  }
  double timeout_val;
  if (napi_get_value_double(env, argv[2], &timeout_val) != napi_ok || !std::isfinite(timeout_val) || timeout_val < 1 || timeout_val > 300000) {
    napi_throw_range_error(env, nullptr, "timeoutMs must be 1..300000");
    return nullptr;
  }
  w->timeout = static_cast<unsigned>(timeout_val);
  napi_valuetype cb_type;
  if (napi_typeof(env, argv[3], &cb_type) != napi_ok || cb_type != napi_function) {
    napi_throw_type_error(env, nullptr, "callback must be a function");
    return nullptr;
  }

  napi_value resource_name, promise;
  napi_create_string_utf8(env, "dub.subscribe", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_threadsafe_function(
          env, argv[3], nullptr, resource_name, 0, 1, nullptr, nullptr, nullptr,
          CallJsStreamCallback, &w->tsfn) != napi_ok) {
    napi_throw_error(env, nullptr, "Cannot create threadsafe function for Dub stream");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, w->tsfn);

  if (napi_create_promise(env, &w->deferred, &promise) != napi_ok ||
      napi_create_async_work(env, nullptr, resource_name, ExecuteSubscribe, CompleteSubscribe, w.get(), &w->work) != napi_ok) {
    napi_throw_error(env, nullptr, "Cannot create Dub subscribe work");
    return nullptr;
  }
  if (napi_queue_async_work(env, w->work) != napi_ok) {
    napi_delete_async_work(env, w->work);
    napi_throw_error(env, nullptr, "Cannot queue Dub subscribe work");
    return nullptr;
  }
  w.release();
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value request, subscribe;
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, Request, nullptr, &request);
  napi_create_function(env, "subscribe", NAPI_AUTO_LENGTH, Subscribe, nullptr, &subscribe);
  napi_set_named_property(env, exports, "request", request);
  napi_set_named_property(env, exports, "subscribe", subscribe);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

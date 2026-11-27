// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/renderer/dub/dub_render_frame_observer.h"

#include <algorithm>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "content/public/renderer/render_frame.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "third_party/blink/public/web/web_script_tool_types.h"
#include "url/gurl.h"
#include "v8/include/v8-container.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-json.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-microtask-queue.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-promise.h"
#include "v8/include/v8-script.h"

namespace dub {
namespace {

constexpr int32_t kDubIsolatedWorldId = 9001;

bool MatchesWildcard(std::string_view text, std::string_view pattern) {
  if (pattern.empty() || pattern == "*") {
    return true;
  }
  if (pattern.find('*') == std::string_view::npos) {
    return text.find(pattern) != std::string_view::npos;
  }
  size_t ti = 0;
  size_t pi = 0;
  size_t star_p = std::string_view::npos;
  size_t star_t = 0;
  while (ti < text.size()) {
    if (pi < pattern.size() && pattern[pi] == text[ti]) {
      ++ti;
      ++pi;
    } else if (pi < pattern.size() && pattern[pi] == '*') {
      star_p = pi++;
      star_t = ti;
    } else if (star_p != std::string_view::npos) {
      pi = star_p + 1;
      ti = ++star_t;
    } else {
      return false;
    }
  }
  while (pi < pattern.size() && pattern[pi] == '*') {
    ++pi;
  }
  return pi == pattern.size();
}

std::string V8ToUtf8(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  if (value.IsEmpty()) {
    return "";
  }
  v8::String::Utf8Value utf8(isolate, value);
  return *utf8 ? std::string(*utf8, utf8.length()) : "";
}

std::string FormatException(v8::Isolate* isolate,
                            v8::Local<v8::Context> context,
                            v8::Local<v8::Value> exception) {
  if (exception.IsEmpty()) {
    return "Unknown JavaScript exception";
  }
  if (exception->IsObject()) {
    v8::Local<v8::Object> obj = exception.As<v8::Object>();
    v8::Local<v8::String> stack_key =
        v8::String::NewFromUtf8Literal(isolate, "stack");
    v8::Local<v8::Value> stack_val;
    if (obj->Get(context, stack_key).ToLocal(&stack_val) &&
        stack_val->IsString()) {
      return V8ToUtf8(isolate, stack_val);
    }
  }
  return V8ToUtf8(isolate, exception);
}

bool SerializeV8Value(v8::Isolate* isolate,
                      v8::Local<v8::Context> context,
                      v8::Local<v8::Value> value,
                      std::string* out_json,
                      std::string* out_error) {
  if (value.IsEmpty() || value->IsUndefined()) {
    *out_json = "null";
    return true;
  }
  if (value->IsFunction() || value->IsSymbol() || value->IsBigInt()) {
    *out_error = "Value is not JSON-serializable";
    return false;
  }
  v8::TryCatch try_catch(isolate);
  v8::Local<v8::String> stringified;
  if (!v8::JSON::Stringify(context, value).ToLocal(&stringified)) {
    *out_error = try_catch.HasCaught()
                     ? FormatException(isolate, context, try_catch.Exception())
                     : "Value could not be serialized to JSON";
    return false;
  }
  if (stringified.IsEmpty() || stringified->IsUndefined()) {
    *out_error = "Value is not JSON-serializable";
    return false;
  }
  *out_json = V8ToUtf8(isolate, stringified);
  return true;
}

struct PromiseReactionEntry {
  base::WeakPtr<DubRenderFrameObserver> observer;
  uint64_t eval_id = 0;
  bool is_reject = false;
};

std::map<uint64_t, PromiseReactionEntry>& PromiseReactions() {
  static base::NoDestructor<std::map<uint64_t, PromiseReactionEntry>> map;
  return *map;
}

uint64_t RegisterReaction(PromiseReactionEntry entry) {
  static uint64_t next_key = 1;
  const uint64_t key = next_key++;
  PromiseReactions().emplace(key, std::move(entry));
  return key;
}

void OnPromiseSettled(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (info.Data().IsEmpty() || !info.Data()->IsNumber()) {
    return;
  }
  const uint64_t key =
      static_cast<uint64_t>(info.Data()->NumberValue(context).FromMaybe(0));
  auto& reactions = PromiseReactions();
  auto it = reactions.find(key);
  if (it == reactions.end()) {
    return;
  }
  PromiseReactionEntry data = std::move(it->second);
  reactions.erase(it);
  if (!data.observer) {
    return;
  }
  v8::Local<v8::Value> arg =
      info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  if (data.is_reject) {
    data.observer->ResolvePendingEval(
        data.eval_id, false, "", "JS_REJECTION",
        FormatException(isolate, context, arg));
    return;
  }
  std::string json;
  std::string err;
  if (!SerializeV8Value(isolate, context, arg, &json, &err)) {
    data.observer->ResolvePendingEval(data.eval_id, false, "",
                                      "NON_SERIALIZABLE", std::move(err));
    return;
  }
  data.observer->ResolvePendingEval(data.eval_id, true, std::move(json), "",
                                    "");
}

struct ExposedBindingEntry {
  base::WeakPtr<DubRenderFrameObserver> observer;
  std::string name;
};

std::map<uint64_t, ExposedBindingEntry>& ExposedBindings() {
  static base::NoDestructor<std::map<uint64_t, ExposedBindingEntry>> map;
  return *map;
}

uint64_t RegisterExposedBinding(ExposedBindingEntry entry) {
  static uint64_t next_key = 1;
  const uint64_t key = next_key++;
  ExposedBindings().emplace(key, std::move(entry));
  return key;
}

void OnExposedFunctionCalled(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  v8::Local<v8::Promise::Resolver> resolver;
  if (!v8::Promise::Resolver::New(context).ToLocal(&resolver)) {
    return;
  }
  info.GetReturnValue().Set(resolver->GetPromise());

  if (info.Data().IsEmpty() || !info.Data()->IsNumber()) {
    std::ignore = resolver->Reject(
        context, v8::Exception::Error(
                     v8::String::NewFromUtf8Literal(isolate, "Invalid binding")));
    return;
  }
  const uint64_t key =
      static_cast<uint64_t>(info.Data()->NumberValue(context).FromMaybe(0));
  auto it = ExposedBindings().find(key);
  if (it == ExposedBindings().end() || !it->second.observer) {
    std::ignore = resolver->Reject(
        context, v8::Exception::Error(v8::String::NewFromUtf8Literal(
                     isolate, "Dub exposed function frame is gone")));
    return;
  }

  v8::Local<v8::Array> args = v8::Array::New(isolate, info.Length());
  for (int i = 0; i < info.Length(); ++i) {
    std::ignore = args->Set(context, i, info[i]);
  }
  std::string args_json = "[]";
  std::string err;
  if (!SerializeV8Value(isolate, context, args, &args_json, &err)) {
    std::ignore = resolver->Reject(
        context,
        v8::Exception::TypeError(
            v8::String::NewFromUtf8(isolate, err.c_str()).ToLocalChecked()));
    return;
  }

  it->second.observer->HandleExposedCallFromV8(it->second.name, args_json,
                                               isolate, context, resolver);
}

std::string ScriptToolErrorCodeName(blink::WebScriptToolErrorCode code) {
  switch (code) {
    case blink::WebScriptToolErrorCode::kInvalidToolName:
      return "UNKNOWN_TOOL";
    case blink::WebScriptToolErrorCode::kInvalidInputArguments:
      return "INVALID_PARAMS";
    case blink::WebScriptToolErrorCode::kMissingRequiredSubmitButton:
      return "TOOL_FAILED";
    case blink::WebScriptToolErrorCode::kToolInvocationFailed:
      return "TOOL_FAILED";
    case blink::WebScriptToolErrorCode::kToolCancelled:
      return "TOOL_CANCELED";
  }
  return "TOOL_FAILED";
}

v8::Local<v8::Context> GetContextForWorld(blink::WebLocalFrame* frame,
                                          v8::Isolate* isolate,
                                          bool isolated_world) {
  if (!isolated_world) {
    return frame->MainWorldScriptContext();
  }
  v8::Local<v8::Value> global =
      frame->ExecuteScriptInIsolatedWorldAndReturnValue(
          kDubIsolatedWorldId,
          blink::WebScriptSource(blink::WebString::FromUtf8("globalThis")),
          blink::BackForwardCacheAware::kAllow);
  if (!global.IsEmpty() && global->IsObject()) {
    return global.As<v8::Object>()->GetCreationContextChecked();
  }
  return v8::Local<v8::Context>();
}

}  // namespace

DubRenderFrameObserver::DubRenderFrameObserver(
    content::RenderFrame* render_frame)
    : content::RenderFrameObserver(render_frame) {
  render_frame->GetAssociatedInterfaceRegistry()
      ->AddInterface<dub::mojom::DubRenderFrame>(base::BindRepeating(
          &DubRenderFrameObserver::OnDubRenderFrameRequest,
          base::Unretained(this)));
}

DubRenderFrameObserver::~DubRenderFrameObserver() {
  FailPendingEvals("FRAME_GONE", "Render frame destroyed during evaluation");
}

void DubRenderFrameObserver::OnDubRenderFrameRequest(
    mojo::PendingAssociatedReceiver<dub::mojom::DubRenderFrame> receiver) {
  receivers_.Add(this, std::move(receiver));
}

void DubRenderFrameObserver::DidClearWindowObject() {
  InstallExposedBindingsInCurrentContext();
  RunInitScriptsForCurrentDocument();
}

void DubRenderFrameObserver::DidStartNavigation(
    const GURL& url,
    std::optional<blink::WebNavigationType> navigation_type) {
  FailPendingEvals("NAVIGATED", "Frame navigated during evaluation");
}

void DubRenderFrameObserver::OnDestruct() {
  FailPendingEvals("FRAME_GONE", "Render frame destroyed during evaluation");
  delete this;
}

void DubRenderFrameObserver::FailPendingEvals(const std::string& code,
                                              const std::string& message) {
  auto pending = std::move(pending_evals_);
  pending_evals_.clear();
  for (auto& [id, cb] : pending) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = code;
    res->error_message = message;
    std::move(cb).Run(std::move(res));
  }
}

void DubRenderFrameObserver::ResolvePendingEval(uint64_t eval_id,
                                                bool ok,
                                                std::string result_json,
                                                std::string error_code,
                                                std::string error_message) {
  auto it = pending_evals_.find(eval_id);
  if (it == pending_evals_.end()) {
    return;
  }
  auto cb = std::move(it->second);
  pending_evals_.erase(it);
  auto res = dub::mojom::EvalResult::New();
  res->ok = ok;
  res->result_json = std::move(result_json);
  res->error_code = std::move(error_code);
  res->error_message = std::move(error_message);
  std::move(cb).Run(std::move(res));
}

void DubRenderFrameObserver::HandleExposedCallFromV8(
    const std::string& name,
    const std::string& args_json,
    v8::Isolate* isolate,
    v8::Local<v8::Context> context,
    v8::Local<v8::Promise::Resolver> resolver) {
  if (!exposed_host_.is_bound()) {
    std::ignore = resolver->Reject(
        context, v8::Exception::Error(v8::String::NewFromUtf8Literal(
                     isolate, "Dub exposed host is disconnected")));
    return;
  }

  struct ResolverState {
    raw_ptr<v8::Isolate> isolate = nullptr;
    v8::Global<v8::Context> context;
    v8::Global<v8::Promise::Resolver> resolver;
  };
  auto state = std::make_unique<ResolverState>();
  state->isolate = isolate;
  state->context.Reset(isolate, context);
  state->resolver.Reset(isolate, resolver);

  exposed_host_->Call(
      name, args_json,
      base::BindOnce(
          [](base::WeakPtr<DubRenderFrameObserver> self,
             std::unique_ptr<ResolverState> st, bool ok,
             const std::string& result_json, const std::string& error) {
            if (!self || !st || !st->isolate) {
              return;
            }
            v8::Isolate* iso = st->isolate;
            v8::HandleScope hs(iso);
            v8::Local<v8::Context> ctx = st->context.Get(iso);
            v8::Local<v8::Promise::Resolver> res = st->resolver.Get(iso);
            if (ctx.IsEmpty() || res.IsEmpty()) {
              return;
            }
            v8::Context::Scope cs(ctx);
            v8::MicrotasksScope microtasks(
                ctx, v8::MicrotasksScope::kRunMicrotasks);
            if (!ok) {
              v8::Local<v8::String> msg =
                  v8::String::NewFromUtf8(
                      iso, error.empty() ? "Exposed call failed" : error.c_str())
                      .ToLocalChecked();
              std::ignore = res->Reject(ctx, v8::Exception::Error(msg));
            } else {
              v8::Local<v8::Value> parsed = v8::Undefined(iso);
              if (!result_json.empty()) {
                v8::Local<v8::String> js;
                if (v8::String::NewFromUtf8(iso, result_json.data(),
                                            v8::NewStringType::kNormal,
                                            static_cast<int>(result_json.size()))
                        .ToLocal(&js)) {
                  std::ignore = v8::JSON::Parse(ctx, js).ToLocal(&parsed);
                }
              }
              std::ignore = res->Resolve(ctx, parsed);
            }
          },
          weak_factory_.GetWeakPtr(), std::move(state)));
}

void DubRenderFrameObserver::InstallExposedBindingsInCurrentContext() {
  if (exposed_names_.empty() || !exposed_host_.is_bound()) {
    return;
  }
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    return;
  }
  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope hs(isolate);
  v8::Local<v8::Context> context = frame->MainWorldScriptContext();
  if (context.IsEmpty()) {
    return;
  }
  v8::Context::Scope cs(context);
  v8::MicrotasksScope microtasks(
      context, v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::TryCatch tc(isolate);
  v8::Local<v8::Object> global = context->Global();
  for (const auto& name : exposed_names_) {
    const uint64_t key =
        RegisterExposedBinding({weak_factory_.GetWeakPtr(), name});
    v8::Local<v8::Function> fn;
    v8::Local<v8::String> prop_name;
    if (v8::Function::New(
            context, &OnExposedFunctionCalled,
            v8::Number::New(isolate, static_cast<double>(key)))
            .ToLocal(&fn) &&
        v8::String::NewFromUtf8(isolate, name.data(),
                                v8::NewStringType::kNormal,
                                static_cast<int>(name.size()))
            .ToLocal(&prop_name)) {
      std::ignore = global->Set(context, prop_name, fn);
    }
  }
}

void DubRenderFrameObserver::RunInitScriptsForCurrentDocument() {
  if (init_scripts_.empty()) {
    return;
  }
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    return;
  }
  const bool is_main = render_frame()->IsMainFrame();
  const std::string doc_url =
      frame->GetDocument().IsNull() ? "" : GURL(frame->GetDocument().Url()).spec();
  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  for (const auto& entry : init_scripts_) {
    if (!entry) {
      continue;
    }
    if (!entry->all_frames && !is_main) {
      continue;
    }
    if (!entry->match.empty() && entry->match != "*" && !doc_url.empty() &&
        !MatchesWildcard(doc_url, entry->match)) {
      continue;
    }
    if (entry->isolated_world) {
      frame->ExecuteScriptInIsolatedWorld(
          kDubIsolatedWorldId,
          blink::WebScriptSource(blink::WebString::FromUtf8(entry->source)),
          blink::BackForwardCacheAware::kAllow);
    } else {
      v8::HandleScope hs(isolate);
      v8::Local<v8::Context> ctx = frame->MainWorldScriptContext();
      if (ctx.IsEmpty()) {
        continue;
      }
      v8::Context::Scope cs(ctx);
      v8::MicrotasksScope microtasks(
          ctx, v8::MicrotasksScope::kDoNotRunMicrotasks);
      v8::TryCatch tc(isolate);
      v8::Local<v8::String> src;
      v8::Local<v8::Script> script;
      if (v8::String::NewFromUtf8(isolate, entry->source.data(),
                                  v8::NewStringType::kNormal,
                                  static_cast<int>(entry->source.size()))
              .ToLocal(&src) &&
          v8::Script::Compile(ctx, src).ToLocal(&script)) {
        std::ignore = script->Run(ctx);
      }
    }
  }
}

void DubRenderFrameObserver::SetInitScripts(
    std::vector<dub::mojom::InitScriptEntryPtr> scripts) {
  init_scripts_ = std::move(scripts);
}

void DubRenderFrameObserver::SetExposedFunctions(
    const std::vector<std::string>& names,
    mojo::PendingRemote<dub::mojom::DubExposedHost> host) {
  exposed_names_ = names;
  exposed_host_.reset();
  if (host.is_valid()) {
    exposed_host_.Bind(std::move(host));
  }
  InstallExposedBindingsInCurrentContext();
}

void DubRenderFrameObserver::Evaluate(const std::string& expression,
                                      EvaluateCallback callback) {
  EvaluateEx(expression, /*isolated_world=*/false, std::move(callback));
}

void DubRenderFrameObserver::EvaluateEx(const std::string& expression,
                                        bool isolated_world,
                                        EvaluateExCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "FRAME_GONE";
    res->error_message = "Frame is unavailable";
    std::move(callback).Run(std::move(res));
    return;
  }

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context =
      GetContextForWorld(frame, isolate, isolated_world);
  if (context.IsEmpty()) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "NO_CONTEXT";
    res->error_message = isolated_world
                             ? "Isolated world V8 context is unavailable"
                             : "Main world V8 context is unavailable";
    std::move(callback).Run(std::move(res));
    return;
  }

  v8::Context::Scope context_scope(context);
  v8::MicrotasksScope microtasks(
      context, v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::TryCatch try_catch(isolate);

  v8::Local<v8::String> source;
  if (!v8::String::NewFromUtf8(isolate, expression.data(),
                               v8::NewStringType::kNormal,
                               static_cast<int>(expression.size()))
           .ToLocal(&source)) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "INVALID_PARAMS";
    res->error_message = "Expression is not valid UTF-8";
    std::move(callback).Run(std::move(res));
    return;
  }

  v8::Local<v8::Script> script;
  if (!v8::Script::Compile(context, source).ToLocal(&script)) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "JS_EXCEPTION";
    res->error_message =
        FormatException(isolate, context, try_catch.Exception());
    std::move(callback).Run(std::move(res));
    return;
  }

  v8::Local<v8::Value> value;
  if (!script->Run(context).ToLocal(&value)) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "JS_EXCEPTION";
    res->error_message =
        FormatException(isolate, context, try_catch.Exception());
    std::move(callback).Run(std::move(res));
    return;
  }

  if (value->IsPromise()) {
    v8::Local<v8::Promise> promise = value.As<v8::Promise>();
    if (promise->State() == v8::Promise::kFulfilled) {
      std::string json;
      std::string err;
      auto res = dub::mojom::EvalResult::New();
      if (!SerializeV8Value(isolate, context, promise->Result(), &json, &err)) {
        res->ok = false;
        res->error_code = "NON_SERIALIZABLE";
        res->error_message = std::move(err);
      } else {
        res->ok = true;
        res->result_json = std::move(json);
      }
      std::move(callback).Run(std::move(res));
      return;
    }
    if (promise->State() == v8::Promise::kRejected) {
      promise->MarkAsHandled();
      auto res = dub::mojom::EvalResult::New();
      res->ok = false;
      res->error_code = "JS_REJECTION";
      res->error_message =
          FormatException(isolate, context, promise->Result());
      std::move(callback).Run(std::move(res));
      return;
    }

    const uint64_t eval_id = next_eval_id_++;
    pending_evals_.emplace(eval_id, std::move(callback));

    const uint64_t fulfill_key = RegisterReaction(
        {weak_factory_.GetWeakPtr(), eval_id, /*is_reject=*/false});
    const uint64_t reject_key = RegisterReaction(
        {weak_factory_.GetWeakPtr(), eval_id, /*is_reject=*/true});

    v8::Local<v8::Function> on_fulfill;
    v8::Local<v8::Function> on_reject;
    if (!v8::Function::New(
             context, &OnPromiseSettled,
             v8::Number::New(isolate, static_cast<double>(fulfill_key)))
             .ToLocal(&on_fulfill) ||
        !v8::Function::New(
             context, &OnPromiseSettled,
             v8::Number::New(isolate, static_cast<double>(reject_key)))
             .ToLocal(&on_reject) ||
        promise->Then(context, on_fulfill, on_reject).IsEmpty()) {
      PromiseReactions().erase(fulfill_key);
      PromiseReactions().erase(reject_key);
      ResolvePendingEval(eval_id, false, "", "EVAL_FAILED",
                         "Failed to attach promise continuation");
      return;
    }
    if (auto* mq = context->GetMicrotaskQueue()) {
      mq->PerformCheckpoint(isolate);
    }
    return;
  }

  std::string json;
  std::string err;
  auto res = dub::mojom::EvalResult::New();
  if (!SerializeV8Value(isolate, context, value, &json, &err)) {
    res->ok = false;
    res->error_code = "NON_SERIALIZABLE";
    res->error_message = std::move(err);
  } else {
    res->ok = true;
    res->result_json = std::move(json);
  }
  std::move(callback).Run(std::move(res));
}

void DubRenderFrameObserver::ListPageTools(ListPageToolsCallback callback) {
  std::vector<dub::mojom::PageToolInfoPtr> out;
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (frame) {
    blink::WebDocument doc = frame->GetDocument();
    if (!doc.IsNull()) {
      for (const auto& decl : doc.ListScriptTools()) {
        auto info = dub::mojom::PageToolInfo::New();
        info->name = decl.name.Utf8();
        info->title = decl.title.Utf8();
        info->description = decl.description.Utf8();
        info->input_schema = decl.input_schema.Utf8();
        info->read_only = decl.read_only.value_or(false);
        info->consequential = decl.consequential.value_or(false);
        out.push_back(std::move(info));
      }
    }
  }
  std::move(callback).Run(std::move(out));
}

void DubRenderFrameObserver::ExecutePageTool(
    const base::UnguessableToken& invocation_id,
    const std::string& name,
    const std::string& input_arguments,
    ExecutePageToolCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame || frame->GetDocument().IsNull()) {
    std::move(callback).Run(false, std::nullopt, false, "FRAME_GONE",
                            "Document is unavailable");
    return;
  }
  blink::WebDocument doc = frame->GetDocument();
  const bool started = doc.ExecuteScriptTool(
      invocation_id, blink::WebString::FromUtf8(name),
      blink::WebString::FromUtf8(input_arguments),
      base::BindOnce(
          [](ExecutePageToolCallback done,
             std::unique_ptr<blink::WebScriptToolDeclaration> decl,
             base::expected<blink::WebString, blink::WebScriptToolError>
                 result) {
            if (!result.has_value()) {
              std::move(done).Run(
                  false, std::nullopt, false,
                  ScriptToolErrorCodeName(result.error().code),
                  result.error().message.Utf8());
              return;
            }
            if (result->IsNull()) {
              std::move(done).Run(true, std::nullopt, true, "", "");
              return;
            }
            std::move(done).Run(true, result->Utf8(), false, "", "");
          },
          std::move(callback)));
  if (!started) {
    return;
  }
}

void DubRenderFrameObserver::CancelPageTool(
    const base::UnguessableToken& invocation_id) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (frame && !frame->GetDocument().IsNull()) {
    frame->GetDocument().CancelScriptTool(invocation_id);
  }
}

void DubRenderFrameObserver::ResolveTarget(const std::string& target,
                                           bool is_selector,
                                           ResolveTargetCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  auto fail = [&](const std::string& msg) {
    auto res = dub::mojom::TargetResolution::New();
    res->found = false;
    res->error = msg;
    std::move(callback).Run(std::move(res));
  };
  if (!frame) {
    fail("Frame is unavailable");
    return;
  }

  std::string quoted_target;
  base::JSONWriter::Write(base::Value(target), &quoted_target);
  // Pierces open Shadow DOM recursively for both CSS selectors and text targets,
  // and always returns a 2-tuple [element | null, metaJson].
  const std::string script_str =
      "(() => {"
      "  const q = " +
      quoted_target +
      ";"
      "  const isSel = " +
      std::string(is_selector ? "true" : "false") +
      ";"
      "  const collectRoots = (root, out = []) => {"
      "    if (!root) return out;"
      "    out.push(root);"
      "    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];"
      "    for (const node of all) {"
      "      if (node.shadowRoot) collectRoots(node.shadowRoot, out);"
      "    }"
      "    return out;"
      "  };"
      "  const deepQuery = (sel) => {"
      "    for (const root of collectRoots(document)) {"
      "      const hit = root.querySelector(sel);"
      "      if (hit) return hit;"
      "    }"
      "    return null;"
      "  };"
      "  const deepQueryAll = (sel) => {"
      "    const res = [];"
      "    for (const root of collectRoots(document)) {"
      "      for (const hit of root.querySelectorAll(sel)) res.push(hit);"
      "    }"
      "    return res;"
      "  };"
      "  let el = null;"
      "  if (isSel) {"
      "    try { el = deepQuery(q); } catch (e) {"
      "      return [null, JSON.stringify({found:false,error:String(e)})];"
      "    }"
      "  } else {"
      "    const needle = q.trim().toLowerCase();"
      "    const candidates = deepQueryAll("
      "      'button,a,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[tabindex]');"
      "    const matchText = (node) => {"
      "      const parts = [node.innerText, node.textContent, node.value,"
      "        node.getAttribute && node.getAttribute('aria-label'),"
      "        node.getAttribute && node.getAttribute('placeholder'),"
      "        node.getAttribute && node.getAttribute('title')];"
      "      return parts.filter(Boolean).map(s => String(s).trim().toLowerCase());"
      "    };"
      "    el = candidates.find(c => matchText(c).some(t => t === needle))"
      "      || candidates.find(c => matchText(c).some(t => t.includes(needle)));"
      "    if (!el) {"
      "      try { el = deepQuery(q); } catch (_) {}"
      "    }"
      "  }"
      "  if (!el) return [null, JSON.stringify({found:false,error:'Target not found: ' + q})];"
      "  el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});"
      "  const r = el.getBoundingClientRect();"
      "  if (r.width <= 0 && r.height <= 0) {"
      "    return [null, JSON.stringify({found:false,error:'Target has zero bounding box'})];"
      "  }"
      "  return [el, JSON.stringify({"
      "    found: true,"
      "    x: Math.round(r.left + r.width / 2),"
      "    y: Math.round(r.top + r.height / 2),"
      "    tag: String(el.tagName || '').toLowerCase()"
      "  })];"
      "})()";

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = frame->MainWorldScriptContext();
  if (context.IsEmpty()) {
    fail("Main world V8 context is unavailable");
    return;
  }
  v8::Context::Scope context_scope(context);
  v8::MicrotasksScope microtasks(
      context, v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::TryCatch try_catch(isolate);
  v8::Local<v8::String> src;
  v8::Local<v8::Script> script;
  v8::Local<v8::Value> value;
  if (!v8::String::NewFromUtf8(isolate, script_str.data(),
                               v8::NewStringType::kNormal,
                               static_cast<int>(script_str.size()))
           .ToLocal(&src) ||
      !v8::Script::Compile(context, src).ToLocal(&script) ||
      !script->Run(context).ToLocal(&value) || !value->IsArray()) {
    fail(try_catch.HasCaught()
             ? FormatException(isolate, context, try_catch.Exception())
             : "Failed to resolve target");
    return;
  }
  v8::Local<v8::Array> pair = value.As<v8::Array>();
  v8::Local<v8::Value> el_val;
  v8::Local<v8::Value> meta_val;
  if (!pair->Get(context, 0).ToLocal(&el_val) ||
      !pair->Get(context, 1).ToLocal(&meta_val) || !meta_val->IsString()) {
    fail("Invalid target resolution output");
    return;
  }
  auto parsed = base::JSONReader::ReadDict(V8ToUtf8(isolate, meta_val),
                                           base::JSON_PARSE_RFC);
  if (!parsed) {
    fail("Invalid target resolution output");
    return;
  }
  auto res = dub::mojom::TargetResolution::New();
  res->found = parsed->FindBool("found").value_or(false);
  if (res->found && !el_val.IsEmpty() && el_val->IsObject()) {
    blink::WebElement web_el = blink::WebElement::FromV8Value(isolate, el_val);
    if (!web_el.IsNull()) {
      res->node_id = web_el.GetDomNodeId();
    }
  }
  res->x = parsed->FindInt("x").value_or(0);
  res->y = parsed->FindInt("y").value_or(0);
  if (const auto* tag = parsed->FindString("tag")) {
    res->tag = *tag;
  }
  if (const auto* err = parsed->FindString("error")) {
    res->error = *err;
  }
  std::move(callback).Run(std::move(res));
}

void DubRenderFrameObserver::Snapshot(uint32_t max_nodes,
                                      bool include_hidden,
                                      SnapshotCallback callback) {
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    std::move(callback).Run(R"({"error":"Frame is unavailable","nodes":[]})");
    return;
  }
  const uint32_t limit = std::clamp<uint32_t>(max_nodes == 0 ? 300 : max_nodes, 1, 2000);
  const std::string script_str =
      "(() => {"
      "  const maxNodes = " +
      std::to_string(limit) +
      ";"
      "  const includeHidden = " +
      std::string(include_hidden ? "true" : "false") +
      ";"
      "  const interactiveSel = 'a[href],button,input,select,textarea,summary,details,h1,h2,h3,label,img[alt],[role],[tabindex],[contenteditable]';"
      "  const els = [];"
      "  const metas = [];"
      "  const inferRole = (el) => {"
      "    const r = el.getAttribute && el.getAttribute('role');"
      "    if (r) return r;"
      "    const tag = (el.tagName || '').toLowerCase();"
      "    if (tag === 'a') return 'link';"
      "    if (tag === 'button') return 'button';"
      "    if (tag === 'select') return 'combobox';"
      "    if (tag === 'textarea') return 'textbox';"
      "    if (tag === 'img') return 'img';"
      "    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';"
      "    if (tag === 'input') {"
      "      const t = (el.type || 'text').toLowerCase();"
      "      if (t === 'checkbox') return 'checkbox';"
      "      if (t === 'radio') return 'radio';"
      "      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';"
      "      return 'textbox';"
      "    }"
      "    return tag;"
      "  };"
      "  const bestName = (el) => {"
      "    const raw = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder')))"
      "      || el.innerText || el.textContent || el.value || '';"
      "    return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 160);"
      "  };"
      "  const bestSelector = (el) => {"
      "    if (el.id) return '#' + CSS.escape(el.id);"
      "    const name = el.getAttribute && el.getAttribute('name');"
      "    const tag = (el.tagName || '').toLowerCase();"
      "    if (name) return tag + '[name=\"' + name.replace(/\"/g, '\\\\\"') + '\"]';"
      "    const testId = el.getAttribute && el.getAttribute('data-testid');"
      "    if (testId) return '[data-testid=\"' + testId.replace(/\"/g, '\\\\\"') + '\"]';"
      "    return tag;"
      "  };"
      "  const walk = (root, inShadow) => {"
      "    if (!root || els.length >= maxNodes) return;"
      "    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];"
      "    for (const el of nodes) {"
      "      if (els.length >= maxNodes) break;"
      "      if (el.matches && el.matches(interactiveSel)) {"
      "        const r = el.getBoundingClientRect();"
      "        const style = getComputedStyle(el);"
      "        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';"
      "        if (visible || includeHidden) {"
      "          els.push(el);"
      "          const meta = {"
      "            role: inferRole(el),"
      "            tag: (el.tagName || '').toLowerCase(),"
      "            name: bestName(el),"
      "            selector: bestSelector(el),"
      "            visible,"
      "            inShadow,"
      "            focused: document.activeElement === el,"
      "            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),"
      "            rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }"
      "          };"
      "          if ('value' in el && el.value !== undefined && el.type !== 'password') meta.value = String(el.value).slice(0, 200);"
      "          if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) meta.checked = Boolean(el.checked);"
      "          if (el.tagName === 'A' && el.href) meta.href = el.href;"
      "          if (el.tagName === 'INPUT' && el.type) meta.type = el.type;"
      "          metas.push(meta);"
      "        }"
      "      }"
      "      if (el.shadowRoot) walk(el.shadowRoot, true);"
      "    }"
      "  };"
      "  walk(document, false);"
      "  return [els, JSON.stringify({"
      "    url: location.href,"
      "    title: document.title,"
      "    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },"
      "    nodes: metas"
      "  })];"
      "})()";

  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope hs(isolate);
  v8::Local<v8::Context> context = frame->MainWorldScriptContext();
  if (context.IsEmpty()) {
    std::move(callback).Run(R"({"error":"Main world V8 context is unavailable","nodes":[]})");
    return;
  }
  v8::Context::Scope cs(context);
  v8::MicrotasksScope microtasks(
      context, v8::MicrotasksScope::kDoNotRunMicrotasks);
  v8::TryCatch tc(isolate);
  v8::Local<v8::String> src;
  v8::Local<v8::Script> script;
  v8::Local<v8::Value> value;
  if (!v8::String::NewFromUtf8(isolate, script_str.data(),
                               v8::NewStringType::kNormal,
                               static_cast<int>(script_str.size()))
           .ToLocal(&src) ||
      !v8::Script::Compile(context, src).ToLocal(&script) ||
      !script->Run(context).ToLocal(&value) || !value->IsArray()) {
    std::move(callback).Run(R"({"error":"Snapshot evaluation failed","nodes":[]})");
    return;
  }

  v8::Local<v8::Array> pair = value.As<v8::Array>();
  v8::Local<v8::Value> els_val;
  v8::Local<v8::Value> json_val;
  if (!pair->Get(context, 0).ToLocal(&els_val) || !els_val->IsArray() ||
      !pair->Get(context, 1).ToLocal(&json_val) || !json_val->IsString()) {
    std::move(callback).Run(R"({"error":"Invalid snapshot payload","nodes":[]})");
    return;
  }
  auto parsed = base::JSONReader::ReadDict(V8ToUtf8(isolate, json_val),
                                           base::JSON_PARSE_RFC);
  if (!parsed) {
    std::move(callback).Run(R"({"error":"Malformed snapshot JSON","nodes":[]})");
    return;
  }
  v8::Local<v8::Array> els_arr = els_val.As<v8::Array>();
  if (base::ListValue* nodes = parsed->FindList("nodes")) {
    const uint32_t count =
        std::min<uint32_t>(els_arr->Length(), static_cast<uint32_t>(nodes->size()));
    for (uint32_t i = 0; i < count; ++i) {
      v8::Local<v8::Value> el_v;
      if (els_arr->Get(context, i).ToLocal(&el_v) && el_v->IsObject()) {
        blink::WebElement web_el = blink::WebElement::FromV8Value(isolate, el_v);
        if (!web_el.IsNull()) {
          if (base::DictValue* d = (*nodes)[i].GetIfDict()) {
            d->Set("nodeId", web_el.GetDomNodeId());
          }
        }
      }
    }
  }
  std::string out_json;
  base::JSONWriter::Write(*parsed, &out_json);
  std::move(callback).Run(std::move(out_json));
}

void DubRenderFrameObserver::WaitFor(const std::string& selector,
                                     const std::string& text,
                                     const std::string& expression,
                                     const std::string& state,
                                     uint32_t timeout_ms,
                                     WaitForCallback callback) {
  std::string q_sel, q_text, q_expr, q_state;
  base::JSONWriter::Write(base::Value(selector), &q_sel);
  base::JSONWriter::Write(base::Value(text), &q_text);
  base::JSONWriter::Write(base::Value(expression), &q_expr);
  base::JSONWriter::Write(base::Value(state.empty() ? "visible" : state), &q_state);
  const uint32_t bounded_timeout = std::clamp<uint32_t>(timeout_ms == 0 ? 10000 : timeout_ms, 50, 120000);

  const std::string wait_js =
      "new Promise((resolve) => {"
      "  const sel = " + q_sel + ";"
      "  const txt = " + q_text + ";"
      "  const expr = " + q_expr + ";"
      "  const state = " + q_state + ";"
      "  const deadline = Date.now() + " + std::to_string(bounded_timeout) + ";"
      "  const collectRoots = (root, out = []) => {"
      "    if (!root) return out; out.push(root);"
      "    for (const n of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {"
      "      if (n.shadowRoot) collectRoots(n.shadowRoot, out);"
      "    } return out;"
      "  };"
      "  const findEl = () => {"
      "    if (!sel) return null;"
      "    for (const r of collectRoots(document)) {"
      "      const hit = r.querySelector(sel); if (hit) return hit;"
      "    } return null;"
      "  };"
      "  const check = () => {"
      "    if (expr) {"
      "      try { const v = (0, eval)(expr); if (v) return { matched: true, value: v }; } catch (_) {}"
      "      return null;"
      "    }"
      "    if (txt) {"
      "      const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';"
      "      const has = bodyText.includes(txt);"
      "      if (state === 'hidden' || state === 'detached') return !has ? { matched: true, text: txt } : null;"
      "      return has ? { matched: true, text: txt } : null;"
      "    }"
      "    if (sel) {"
      "      const el = findEl();"
      "      if (state === 'detached') return !el ? { matched: true, selector: sel } : null;"
      "      if (!el) return state === 'hidden' ? { matched: true, selector: sel } : null;"
      "      const r = el.getBoundingClientRect();"
      "      const st = getComputedStyle(el);"
      "      const vis = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';"
      "      if (state === 'attached') return { matched: true, selector: sel };"
      "      if (state === 'hidden') return !vis ? { matched: true, selector: sel } : null;"
      "      return vis ? { matched: true, selector: sel } : null;"
      "    }"
      "    return { matched: true };"
      "  };"
      "  const done = (ok, detail, error) => {"
      "    clearInterval(iv); if (obs) obs.disconnect();"
      "    resolve({ ok, detail: detail || {}, error: error || '' });"
      "  };"
      "  let obs = null;"
      "  let iv = null;"
      "  const immediate = check();"
      "  if (immediate) return resolve({ ok: true, detail: immediate, error: '' });"
      "  const step = () => {"
      "    const hit = check();"
      "    if (hit) return done(true, hit, '');"
      "    if (Date.now() >= deadline) return done(false, {}, 'Timed out waiting for condition');"
      "  };"
      "  try {"
      "    obs = new MutationObserver(step);"
      "    if (document.documentElement) obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });"
      "  } catch (_) {}"
      "  iv = setInterval(step, 50);"
      "})";

  EvaluateEx(
      wait_js, /*isolated_world=*/false,
      base::BindOnce(
          [](WaitForCallback done, dub::mojom::EvalResultPtr eval) {
            if (!eval || !eval->ok) {
              std::move(done).Run(
                  false, "{}",
                  eval ? eval->error_message : "Wait evaluation failed");
              return;
            }
            auto parsed = base::JSONReader::ReadDict(eval->result_json,
                                                     base::JSON_PARSE_RFC);
            if (!parsed) {
              std::move(done).Run(false, "{}", "Malformed wait result");
              return;
            }
            const bool ok = parsed->FindBool("ok").value_or(false);
            std::string detail_json = "{}";
            if (const auto* d = parsed->FindDict("detail")) {
              base::JSONWriter::Write(*d, &detail_json);
            }
            const auto* err = parsed->FindString("error");
            std::move(done).Run(ok, detail_json, err ? *err : "");
          },
          std::move(callback)));
}

void DubRenderFrameObserver::ClockControl(const std::string& op,
                                          int64_t epoch_ms,
                                          int64_t delta_ms,
                                          uint32_t frames,
                                          ClockControlCallback callback) {
  auto out = dub::mojom::ClockState::New();
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  if (!frame) {
    out->ok = false;
    out->error_code = "FRAME_GONE";
    out->error_message = "Frame is unavailable";
    std::move(callback).Run(std::move(out));
    return;
  }
  blink::WebLocalFrame::DubClockResult res = frame->ControlDubClock(
      blink::WebString::FromUtf8(op), epoch_ms, delta_ms, frames);
  out->ok = res.ok;
  out->frozen = res.frozen;
  out->epoch_ms = res.epoch_ms;
  out->performance_now_ms = res.performance_now_ms;
  out->timers_fired = res.timers_fired;
  out->timers_capped = res.timers_capped;
  out->frames_stepped = res.frames_stepped;
  out->error_code = res.error_code.Utf8();
  out->error_message = res.error_message.Utf8();
  std::move(callback).Run(std::move(out));
}

}  // namespace dub

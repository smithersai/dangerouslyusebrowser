// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/renderer/dub/dub_render_frame_observer.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "content/public/renderer/render_frame.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_tool_types.h"
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

void DubRenderFrameObserver::Evaluate(const std::string& expression,
                                      EvaluateCallback callback) {
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
  v8::Local<v8::Context> context = frame->MainWorldScriptContext();
  if (context.IsEmpty()) {
    auto res = dub::mojom::EvalResult::New();
    res->ok = false;
    res->error_code = "NO_CONTEXT";
    res->error_message = "Main world V8 context is unavailable";
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
              // Cross-document navigation: result will be fetched from the new
              // Document via GetCrossDocumentScriptToolResult.
              std::move(done).Run(true, std::nullopt, true, "", "");
              return;
            }
            std::move(done).Run(true, result->Utf8(), false, "", "");
          },
          std::move(callback)));
  if (!started) {
    // Callback already invoked or failed to start.
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
  const std::string script_str =
      "(() => {"
      "  const q = " +
      quoted_target +
      ";"
      "  const isSel = " +
      std::string(is_selector ? "true" : "false") +
      ";"
      "  let el = null;"
      "  if (isSel) {"
      "    try { el = document.querySelector(q); } catch (e) { return "
      "JSON.stringify({found:false,error:String(e)}); }"
      "  } else {"
      "    const needle = q.trim().toLowerCase();"
      "    const candidates = Array.from(document.querySelectorAll("
      "      'button,a,input,select,textarea,[role=button],[role=link],[tabindex]'));"
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
      "      try { el = document.querySelector(q); } catch (_) {}"
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

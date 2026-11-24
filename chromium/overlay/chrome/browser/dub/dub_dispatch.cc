// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_dispatch.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/barrier_closure.h"
#include "base/base64.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/threading/thread_restrictions.h"
#include "base/time/time.h"
#include "base/unguessable_token.h"
#include "chrome/browser/dub/dub_build_info.h"
#include "chrome/browser/dub/dub_network.h"
#include "chrome/browser/dub/dub_upload.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/actor.mojom.h"
#include "chrome/common/chrome_render_frame.mojom.h"
#include "chrome/common/dub_frame.mojom.h"
#include "components/actor/core/task_id.h"
#include "components/tabs/public/tab_interface.h"
#include "components/version_info/version_info.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/point.h"
#include "url/gurl.h"

namespace dub {

base::DictValue Result(base::Value value) {
  return base::DictValue().Set("result", std::move(value));
}

base::DictValue Error(const std::string& code, const std::string& message) {
  return base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message));
}

namespace {

struct Tab {
  raw_ptr<BrowserWindowInterface> window = nullptr;
  raw_ptr<content::WebContents> contents = nullptr;
  int index = -1;
};

int TabId(content::WebContents* contents) {
  auto* tab_interface = tabs::TabInterface::GetFromContents(contents);
  return tab_interface ? tab_interface->GetHandle().raw_value() : 0;
}

std::string FrameIdString(content::GlobalRenderFrameHostId id) {
  return base::NumberToString(id.child_id.GetUnsafeValue()) + ":" +
         base::NumberToString(id.frame_routing_id);
}

bool MatchesSelectedProfile(BrowserWindowInterface* window,
                            const SessionContext& session) {
  if (!window || !session.profile) {
    return false;
  }
  return window->GetProfile() == session.profile.get();
}

BrowserWindowInterface* FindWindowForProfile(const SessionContext& session) {
  BrowserWindowInterface* found = nullptr;
  auto* windows = GlobalBrowserCollection::GetInstance();
  if (!windows) {
    return nullptr;
  }
  windows->ForEach(
      [&](BrowserWindowInterface* window) {
        if (MatchesSelectedProfile(window, session)) {
          found = window;
          return false;
        }
        return true;
      },
      BrowserCollection::Order::kActivation);
  return found;
}

Tab FindTab(const SessionContext& session, int id) {
  Tab found;
  auto* windows = GlobalBrowserCollection::GetInstance();
  if (!windows || id <= 0) {
    return found;
  }
  windows->ForEach([&](BrowserWindowInterface* window) {
    if (!MatchesSelectedProfile(window, session)) {
      return true;
    }
    auto* model = window->GetTabStripModel();
    if (!model) {
      return true;
    }
    for (int i = 0; i < model->count(); ++i) {
      auto* contents = model->GetWebContentsAt(i);
      if (contents && TabId(contents) == id) {
        found = {window, contents, i};
        return false;
      }
    }
    return true;
  });
  return found;
}

base::DictValue Describe(const Tab& tab) {
  auto* model = tab.window->GetTabStripModel();
  return base::DictValue()
      .Set("id", TabId(tab.contents))
      .Set("url", tab.contents->GetVisibleURL().spec())
      .Set("title", base::UTF16ToUTF8(tab.contents->GetTitle()))
      .Set("active", model && model->active_index() == tab.index)
      .Set("loading", tab.contents->IsLoading());
}

base::ListValue SupportedMethods() {
  base::ListValue methods;
  for (const char* method :
       {"browser.info", "tabs.list", "tabs.open", "tabs.close",
        "tabs.activate", "tabs.navigate", "page.evaluate", "page.screenshot",
        "tools.list", "tools.call", "profile.info", "profile.clear",
        "net.set", "net.list", "net.remove", "net.log"}) {
    methods.Append(method);
  }
  return methods;
}

base::ListValue SupportedActorTools() {
  base::ListValue tools;
  for (const char* tool :
       {"actor.click", "actor.type", "actor.scroll", "actor.select",
        "actor.drag", "actor.navigate", "actor.switch_tab",
        "actor.upload_file"}) {
    tools.Append(tool);
  }
  return tools;
}

base::DictValue MakeActorToolDescriptor(const char* name,
                                        const char* description,
                                        const char* schema_json) {
  base::DictValue d;
  d.Set("name", name);
  d.Set("source", "actor");
  d.Set("description", description);
  if (auto parsed = base::JSONReader::Read(schema_json, base::JSON_PARSE_RFC)) {
    d.Set("inputSchema", std::move(*parsed));
  }
  return d;
}

void CancelActorInFrame(content::GlobalRenderFrameHostId frame_id,
                        actor::TaskId task_id) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto* rfh = content::RenderFrameHost::FromID(frame_id);
  if (!rfh || !rfh->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame> remote;
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(&remote);
  if (remote.is_bound()) {
    remote->CancelTool(task_id);
  }
}

void CancelPageToolInFrame(content::GlobalRenderFrameHostId frame_id,
                           base::UnguessableToken invocation_id) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto* rfh = content::RenderFrameHost::FromID(frame_id);
  if (!rfh || !rfh->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<dub::mojom::DubRenderFrame> remote;
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(&remote);
  if (remote.is_bound()) {
    remote->CancelPageTool(invocation_id);
  }
}

// Helper for fetching a cross-document WebMCP tool result after navigation.
class CrossDocScriptToolWaiter : public content::WebContentsObserver {
 public:
  CrossDocScriptToolWaiter(content::WebContents* contents,
                           base::UnguessableToken invocation_id,
                           std::string frame_id,
                           Reply reply)
      : content::WebContentsObserver(contents),
        invocation_id_(invocation_id),
        frame_id_(std::move(frame_id)),
        reply_(std::move(reply)) {}

  void DocumentOnLoadCompletedInPrimaryMainFrame() override {
    auto* rfh = web_contents()->GetPrimaryMainFrame();
    if (!rfh || !rfh->IsRenderFrameLive()) {
      Finish(Error("FRAME_GONE", "Navigated frame is not live"));
      return;
    }
    auto remote = std::make_unique<
        mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* raw = remote->get();
    raw->GetCrossDocumentScriptToolResult(
        invocation_id_,
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](CrossDocScriptToolWaiter* self,
                   std::unique_ptr<
                       mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>
                       keep_alive,
                   const std::string& result) {
                  base::DictValue val;
                  val.Set("output", result);
                  val.Set("frameId", self->frame_id_);
                  val.Set("crossDocument", true);
                  self->Finish(Result(base::Value(std::move(val))));
                },
                base::Unretained(this), std::move(remote)),
            std::string()));
  }

  void WebContentsDestroyed() override {
    Finish(Error("FRAME_GONE", "Tab closed during cross-document tool result"));
  }

 private:
  void Finish(base::DictValue response) {
    if (reply_) {
      std::move(reply_).Run(std::move(response));
    }
    delete this;
  }

  base::UnguessableToken invocation_id_;
  std::string frame_id_;
  Reply reply_;
};

void DispatchActorInvocation(content::GlobalRenderFrameHostId frame_id,
                             actor::mojom::ToolInvocationPtr invocation,
                             bool clear_upload_after,
                             Reply reply,
                             CancelSetter set_cancel) {
  auto* rfh = content::RenderFrameHost::FromID(frame_id);
  if (!rfh || !rfh->IsRenderFrameLive()) {
    if (clear_upload_after) {
      ClearFileUpload(frame_id);
    }
    std::move(reply).Run(Error("FRAME_GONE", "Target frame is not live"));
    return;
  }
  const actor::TaskId task_id = invocation->task_id;
  if (set_cancel) {
    std::move(set_cancel)
        .Run(base::BindOnce(
            [](content::GlobalRenderFrameHostId fid, actor::TaskId tid,
               bool clear_upload) {
              if (clear_upload) {
                ClearFileUpload(fid);
              }
              CancelActorInFrame(fid, tid);
            },
            frame_id, task_id, clear_upload_after));
  }

  auto remote = std::make_unique<
      mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>();
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
  auto* render_frame = remote->get();
  render_frame->InvokeTool(
      std::move(invocation),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](std::unique_ptr<
                     mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>
                     keep_alive,
                 content::GlobalRenderFrameHostId fid, bool clear_upload,
                 Reply done, actor::mojom::ActionResultPtr result) {
                if (clear_upload) {
                  ClearFileUpload(fid);
                }
                if (!result) {
                  std::move(done).Run(Error(
                      "FRAME_GONE", "Renderer closed during actor invocation"));
                  return;
                }
                if (result->code != actor::mojom::ActionResultCode::kOk) {
                  std::move(done).Run(Error(
                      "ACTOR_FAILED",
                      result->message.empty()
                          ? ("Actor error code " +
                             base::NumberToString(
                                 static_cast<int>(result->code)))
                          : result->message));
                  return;
                }
                base::DictValue value;
                value.Set("code", static_cast<int>(result->code));
                value.Set("message", result->message);
                if (result->script_tool_response &&
                    result->script_tool_response->result) {
                  value.Set("output", *result->script_tool_response->result);
                }
                std::move(done).Run(Result(base::Value(std::move(value))));
              },
              std::move(remote), frame_id, clear_upload_after,
              std::move(reply)),
          actor::mojom::ActionResultPtr()));
}

void ResolveTargetThenRun(
    content::GlobalRenderFrameHostId frame_id,
    const base::DictValue& input,
    base::OnceCallback<void(actor::mojom::ToolTargetPtr, std::string error)>
        callback) {
  if (auto node = input.FindInt("nodeId")) {
    std::move(callback).Run(actor::mojom::ToolTarget::NewDomNodeId(*node), "");
    return;
  }
  if (auto x = input.FindInt("x"); x && input.FindInt("y")) {
    std::move(callback).Run(
        actor::mojom::ToolTarget::NewCoordinateDip(
            gfx::Point(*x, *input.FindInt("y"))),
        "");
    return;
  }
  const std::string* selector = input.FindString("selector");
  const std::string* target = input.FindString("target");
  if (!selector && !target) {
    std::move(callback).Run(
        nullptr,
        "Requires nodeId, integer x/y coordinates, selector, or target text");
    return;
  }
  auto* rfh = content::RenderFrameHost::FromID(frame_id);
  if (!rfh || !rfh->IsRenderFrameLive()) {
    std::move(callback).Run(nullptr, "Target frame is not live");
    return;
  }
  auto remote =
      std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
  auto* dub_frame = remote->get();
  dub_frame->ResolveTarget(
      selector ? *selector : *target, selector != nullptr,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](std::unique_ptr<
                     mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                     keep_alive,
                 base::OnceCallback<void(actor::mojom::ToolTargetPtr,
                                         std::string)> done,
                 dub::mojom::TargetResolutionPtr res) {
                if (!res || !res->found) {
                  std::move(done).Run(
                      nullptr,
                      res && !res->error.empty() ? res->error
                                                 : "Target resolution failed");
                  return;
                }
                if (res->node_id > 0) {
                  std::move(done).Run(
                      actor::mojom::ToolTarget::NewDomNodeId(res->node_id), "");
                  return;
                }
                std::move(done).Run(
                    actor::mojom::ToolTarget::NewCoordinateDip(
                        gfx::Point(res->x, res->y)),
                    "");
              },
              std::move(remote), std::move(callback)),
          dub::mojom::TargetResolutionPtr()));
}

void HandleToolsList(const Tab& tab, Reply reply) {
  struct Collector {
    base::ListValue tools;
    Reply reply;
  };
  auto collector = std::make_shared<Collector>();
  collector->reply = std::move(reply);

  collector->tools.Append(MakeActorToolDescriptor(
      "actor.click", "Click a target element or viewport coordinate",
      R"({"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"nodeId":{"type":"integer"},"selector":{"type":"string"},"target":{"type":"string"},"button":{"type":"string","enum":["left","right"]},"count":{"type":"integer","enum":[1,2]}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.type", "Focus a target and type text via native actor input",
      R"({"type":"object","required":["text"],"properties":{"text":{"type":"string"},"enter":{"type":"boolean"},"mode":{"type":"string","enum":["replace","append","prepend"]},"x":{"type":"integer"},"y":{"type":"integer"},"nodeId":{"type":"integer"},"selector":{"type":"string"},"target":{"type":"string"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.scroll", "Scroll the viewport or target element",
      R"({"type":"object","properties":{"direction":{"type":"string","enum":["up","down","left","right"]},"distance":{"type":"number"},"x":{"type":"integer"},"y":{"type":"integer"},"selector":{"type":"string"},"target":{"type":"string"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.select", "Select an <option> value in a <select> element",
      R"({"type":"object","required":["value"],"properties":{"value":{"type":"string"},"x":{"type":"integer"},"y":{"type":"integer"},"nodeId":{"type":"integer"},"selector":{"type":"string"},"target":{"type":"string"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.drag", "Drag from one coordinate to another",
      R"({"type":"object","required":["x","y","toX","toY"],"properties":{"x":{"type":"integer"},"y":{"type":"integer"},"toX":{"type":"integer"},"toY":{"type":"integer"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.navigate", "Navigate the tab to a URL",
      R"({"type":"object","required":["url"],"properties":{"url":{"type":"string"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.switch_tab", "Activate a tab in the selected profile",
      R"({"type":"object","required":["targetTab"],"properties":{"targetTab":{"type":"integer"}}})"));
  collector->tools.Append(MakeActorToolDescriptor(
      "actor.upload_file", "Upload explicit local file(s) to a file input",
      R"({"type":"object","properties":{"path":{"type":"string"},"files":{"type":"array","items":{"type":"string"}},"selector":{"type":"string"},"target":{"type":"string"},"x":{"type":"integer"},"y":{"type":"integer"}}})"));

  std::vector<content::GlobalRenderFrameHostId> frames;
  tab.contents->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
    if (rfh && rfh->IsRenderFrameLive()) {
      frames.push_back(rfh->GetGlobalId());
    }
  });

  if (frames.empty()) {
    base::DictValue out;
    out.Set("tools", std::move(collector->tools));
    std::move(collector->reply).Run(Result(base::Value(std::move(out))));
    return;
  }

  auto finish = base::BarrierClosure(
      frames.size(),
      base::BindOnce(
          [](std::shared_ptr<Collector> c) {
            base::DictValue out;
            out.Set("tools", std::move(c->tools));
            std::move(c->reply).Run(Result(base::Value(std::move(out))));
          },
          collector));

  for (const auto& fid : frames) {
    auto* rfh = content::RenderFrameHost::FromID(fid);
    if (!rfh || !rfh->IsRenderFrameLive()) {
      finish.Run();
      continue;
    }
    const std::string frame_id_str = FrameIdString(fid);
    const std::string frame_url = rfh->GetLastCommittedURL().spec();
    const bool is_main = rfh->IsInPrimaryMainFrame();
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* dub_frame = remote->get();
    dub_frame->ListPageTools(mojo::WrapCallbackWithDefaultInvokeIfNotRun(
        base::BindOnce(
            [](std::unique_ptr<
                   mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                   keep_alive,
               std::shared_ptr<Collector> c, std::string fid_str,
               std::string url_str, bool main_frame, base::RepeatingClosure done,
               std::vector<dub::mojom::PageToolInfoPtr> page_tools) {
              for (const auto& t : page_tools) {
                base::DictValue d;
                d.Set("name", "page." + t->name);
                d.Set("rawName", t->name);
                d.Set("source", "webmcp");
                d.Set("frameId", fid_str);
                d.Set("url", url_str);
                d.Set("isMainFrame", main_frame);
                if (!t->title.empty()) {
                  d.Set("title", t->title);
                }
                d.Set("description", t->description);
                if (!t->input_schema.empty()) {
                  if (auto schema = base::JSONReader::Read(
                          t->input_schema, base::JSON_PARSE_RFC)) {
                    d.Set("inputSchema", std::move(*schema));
                  } else {
                    d.Set("inputSchema", t->input_schema);
                  }
                }
                d.Set("readOnly", t->read_only);
                d.Set("consequential", t->consequential);
                c->tools.Append(std::move(d));
              }
              done.Run();
            },
            std::move(remote), collector, frame_id_str, frame_url, is_main,
            finish),
        std::vector<dub::mojom::PageToolInfoPtr>()));
  }
}

void ExecutePageToolInFrame(content::WebContents* contents,
                            content::GlobalRenderFrameHostId frame_id,
                            const std::string& raw_name,
                            const std::string& args_json,
                            Reply reply,
                            CancelSetter set_cancel) {
  auto* rfh = content::RenderFrameHost::FromID(frame_id);
  if (!rfh || !rfh->IsRenderFrameLive()) {
    std::move(reply).Run(Error("FRAME_GONE", "Target frame is not live"));
    return;
  }
  const base::UnguessableToken invocation_id = base::UnguessableToken::Create();
  const std::string frame_id_str = FrameIdString(frame_id);
  if (set_cancel) {
    std::move(set_cancel)
        .Run(base::BindOnce(&CancelPageToolInFrame, frame_id, invocation_id));
  }

  auto remote =
      std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
  auto* dub_frame = remote->get();
  base::WeakPtr<content::WebContents> weak_contents = contents->GetWeakPtr();

  dub_frame->ExecutePageTool(
      invocation_id, raw_name, args_json,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](std::unique_ptr<
                     mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                     keep_alive,
                 base::WeakPtr<content::WebContents> wc,
                 base::UnguessableToken inv_id, std::string fid_str, Reply done,
                 bool ok, const std::optional<std::string>& result,
                 bool navigated, const std::string& err_code,
                 const std::string& err_msg) {
                if (!ok) {
                  std::move(done).Run(Error(
                      err_code.empty() ? "TOOL_FAILED" : err_code,
                      err_msg.empty() ? "Page tool failed" : err_msg));
                  return;
                }
                if (navigated) {
                  if (!wc) {
                    std::move(done).Run(Error(
                        "FRAME_GONE",
                        "Tab closed during cross-document tool navigation"));
                    return;
                  }
                  new CrossDocScriptToolWaiter(wc.get(), inv_id,
                                                std::move(fid_str),
                                                std::move(done));
                  return;
                }
                base::DictValue val;
                val.Set("frameId", fid_str);
                if (result.has_value()) {
                  if (auto parsed =
                          base::JSONReader::Read(*result, base::JSON_PARSE_RFC)) {
                    val.Set("output", std::move(*parsed));
                  } else {
                    val.Set("output", *result);
                  }
                } else {
                  val.Set("output", base::Value());
                }
                std::move(done).Run(Result(base::Value(std::move(val))));
              },
              std::move(remote), weak_contents, invocation_id, frame_id_str,
              std::move(reply)),
          false, std::nullopt, false, "FRAME_GONE",
          "Renderer closed during WebMCP tool execution"));
}

void HandlePageToolCall(const Tab& tab,
                        const std::string& raw_name,
                        const base::DictValue& input,
                        Reply reply,
                        CancelSetter set_cancel) {
  base::DictValue clean_input = input.Clone();
  std::string requested_frame_id;
  if (const auto* fid = clean_input.FindString("frameId")) {
    requested_frame_id = *fid;
    clean_input.Remove("frameId");
  }
  std::string args_json;
  if (!base::JSONWriter::Write(clean_input, &args_json)) {
    std::move(reply).Run(
        Error("INVALID_PARAMS", "Cannot serialize tool input"));
    return;
  }

  if (!requested_frame_id.empty()) {
    content::GlobalRenderFrameHostId matched;
    tab.contents->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
      if (rfh && rfh->IsRenderFrameLive() &&
          FrameIdString(rfh->GetGlobalId()) == requested_frame_id) {
        matched = rfh->GetGlobalId();
      }
    });
    if (!matched) {
      std::move(reply).Run(
          Error("FRAME_NOT_FOUND", "Frame not found: " + requested_frame_id));
      return;
    }
    ExecutePageToolInFrame(tab.contents.get(), matched, raw_name, args_json,
                           std::move(reply), std::move(set_cancel));
    return;
  }

  // Locate the frame hosting this WebMCP tool across all live frames.
  std::vector<content::GlobalRenderFrameHostId> frames;
  tab.contents->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
    if (rfh && rfh->IsRenderFrameLive()) {
      frames.push_back(rfh->GetGlobalId());
    }
  });
  if (frames.empty()) {
    std::move(reply).Run(Error("FRAME_GONE", "No live frames in tab"));
    return;
  }

  struct Finder {
    std::vector<content::GlobalRenderFrameHostId> matches;
    base::WeakPtr<content::WebContents> contents;
    std::string raw_name;
    std::string args_json;
    Reply reply;
    CancelSetter set_cancel;
  };
  auto finder = std::make_shared<Finder>();
  finder->contents = tab.contents->GetWeakPtr();
  finder->raw_name = raw_name;
  finder->args_json = args_json;
  finder->reply = std::move(reply);
  finder->set_cancel = std::move(set_cancel);

  auto finish = base::BarrierClosure(
      frames.size(),
      base::BindOnce(
          [](std::shared_ptr<Finder> f) {
            if (!f->contents) {
              std::move(f->reply).Run(
                  Error("FRAME_GONE", "Tab closed before tool invocation"));
              return;
            }
            if (f->matches.empty()) {
              std::move(f->reply).Run(Error(
                  "UNKNOWN_TOOL",
                  "No frame in tab has registered WebMCP tool: " +
                      f->raw_name));
              return;
            }
            if (f->matches.size() > 1) {
              std::move(f->reply).Run(Error(
                  "AMBIGUOUS_TOOL",
                  "Multiple frames register WebMCP tool '" + f->raw_name +
                      "'; specify frameId in input"));
              return;
            }
            ExecutePageToolInFrame(f->contents.get(), f->matches[0],
                                   f->raw_name, f->args_json,
                                   std::move(f->reply),
                                   std::move(f->set_cancel));
          },
          finder));

  for (const auto& fid : frames) {
    auto* rfh = content::RenderFrameHost::FromID(fid);
    if (!rfh || !rfh->IsRenderFrameLive()) {
      finish.Run();
      continue;
    }
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* dub_frame = remote->get();
    dub_frame->ListPageTools(mojo::WrapCallbackWithDefaultInvokeIfNotRun(
        base::BindOnce(
            [](std::unique_ptr<
                   mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                   keep_alive,
               std::shared_ptr<Finder> f, content::GlobalRenderFrameHostId id,
               base::RepeatingClosure done,
               std::vector<dub::mojom::PageToolInfoPtr> tools) {
              for (const auto& t : tools) {
                if (t->name == f->raw_name) {
                  f->matches.push_back(id);
                  break;
                }
              }
              done.Run();
            },
            std::move(remote), finder, fid, finish),
        std::vector<dub::mojom::PageToolInfoPtr>()));
  }
}

void InvokeTool(const SessionContext& session,
                const Tab& tab,
                const std::string& name,
                const base::DictValue& input,
                Reply reply,
                CancelSetter set_cancel) {
  if (name.starts_with("page.")) {
    HandlePageToolCall(tab, name.substr(5), input, std::move(reply),
                       std::move(set_cancel));
    return;
  }

  if (name == "actor.navigate") {
    const auto* url = input.FindString("url");
    if (!url || !GURL(*url).is_valid()) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "actor.navigate requires a valid url"));
      return;
    }
    tab.contents->GetController().LoadURL(
        GURL(*url), content::Referrer(), ui::PAGE_TRANSITION_TYPED,
        std::string());
    std::move(reply).Run(Result(base::Value(Describe(tab))));
    return;
  }

  if (name == "actor.switch_tab") {
    const auto target_id = input.FindInt("targetTab");
    if (!target_id || *target_id <= 0) {
      std::move(reply).Run(Error("INVALID_PARAMS",
                                 "actor.switch_tab requires positive targetTab"));
      return;
    }
    const Tab target = FindTab(session, *target_id);
    if (!target.contents) {
      std::move(reply).Run(Error(
          "TAB_NOT_FOUND",
          "Tab " + std::to_string(*target_id) + " does not exist"));
      return;
    }
    target.window->GetTabStripModel()->ActivateTabAt(target.index);
    std::move(reply).Run(Result(base::Value(Describe(target))));
    return;
  }

  auto* rfh = tab.contents->GetPrimaryMainFrame();
  if (!rfh || !rfh->IsRenderFrameLive()) {
    std::move(reply).Run(Error("FRAME_GONE", "Target main frame is not live"));
    return;
  }
  const content::GlobalRenderFrameHostId frame_id = rfh->GetGlobalId();
  const actor::TaskId task_id(session.next_task_id.Run());

  if (name == "actor.upload_file") {
    std::vector<base::FilePath> paths;
    if (const auto* single = input.FindString("path")) {
      paths.emplace_back(*single);
    } else if (const auto* list = input.FindList("files")) {
      for (const auto& item : *list) {
        if (item.is_string()) {
          paths.emplace_back(item.GetString());
        }
      }
    }
    if (paths.empty()) {
      std::move(reply).Run(Error(
          "INVALID_PARAMS",
          "actor.upload_file requires path (string) or files (string[])"));
      return;
    }
    {
      base::ScopedAllowBlockingForTesting allow_io;
      for (const auto& p : paths) {
        if (!p.IsAbsolute() || !base::PathExists(p)) {
          std::move(reply).Run(Error(
              "INVALID_PARAMS",
              "Upload file must be an existing absolute path: " + p.value()));
          return;
        }
      }
    }
    ArmFileUpload(frame_id, std::move(paths));
    ResolveTargetThenRun(
        frame_id, input,
        base::BindOnce(
            [](content::GlobalRenderFrameHostId fid, actor::TaskId tid,
               Reply done, CancelSetter cancel_setter,
               actor::mojom::ToolTargetPtr target, std::string err) {
              if (!target) {
                ClearFileUpload(fid);
                std::move(done).Run(Error("INVALID_PARAMS", err));
                return;
              }
              auto invocation = actor::mojom::ToolInvocation::New();
              invocation->task_id = tid;
              invocation->target = std::move(target);
              invocation->action = actor::mojom::ToolAction::NewClick(
                  actor::mojom::ClickAction::New(
                      actor::mojom::ClickType::kLeft,
                      actor::mojom::ClickCount::kSingle));
              DispatchActorInvocation(fid, std::move(invocation),
                                      /*clear_upload_after=*/true,
                                      std::move(done),
                                      std::move(cancel_setter));
            },
            frame_id, task_id, std::move(reply), std::move(set_cancel)));
    return;
  }

  actor::mojom::ToolActionPtr action;
  if (name == "actor.click") {
    auto click_type = actor::mojom::ClickType::kLeft;
    if (const auto* btn = input.FindString("button"); btn && *btn == "right") {
      click_type = actor::mojom::ClickType::kRight;
    }
    auto click_count = input.FindInt("count").value_or(1) == 2
                           ? actor::mojom::ClickCount::kDouble
                           : actor::mojom::ClickCount::kSingle;
    action = actor::mojom::ToolAction::NewClick(
        actor::mojom::ClickAction::New(click_type, click_count));
  } else if (name == "actor.type") {
    const auto* text = input.FindString("text");
    if (!text) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "actor.type requires text"));
      return;
    }
    auto mode = actor::mojom::TypeAction::Mode::kDeleteExisting;
    if (const auto* m = input.FindString("mode")) {
      if (*m == "append") {
        mode = actor::mojom::TypeAction::Mode::kAppend;
      } else if (*m == "prepend") {
        mode = actor::mojom::TypeAction::Mode::kPrepend;
      }
    }
    action = actor::mojom::ToolAction::NewType(actor::mojom::TypeAction::New(
        mode, *text, input.FindBool("enter").value_or(false)));
  } else if (name == "actor.scroll") {
    auto dir = actor::mojom::ScrollAction::ScrollDirection::kDown;
    if (const auto* d = input.FindString("direction")) {
      if (*d == "up") {
        dir = actor::mojom::ScrollAction::ScrollDirection::kUp;
      } else if (*d == "left") {
        dir = actor::mojom::ScrollAction::ScrollDirection::kLeft;
      } else if (*d == "right") {
        dir = actor::mojom::ScrollAction::ScrollDirection::kRight;
      }
    }
    const float dist =
        static_cast<float>(input.FindDouble("distance").value_or(300.0));
    if (dist <= 0) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "actor.scroll distance must be positive"));
      return;
    }
    action = actor::mojom::ToolAction::NewScroll(
        actor::mojom::ScrollAction::New(dir, dist));
  } else if (name == "actor.select") {
    const auto* val = input.FindString("value");
    if (!val) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "actor.select requires value"));
      return;
    }
    action = actor::mojom::ToolAction::NewSelect(
        actor::mojom::SelectAction::New(*val));
  } else if (name == "actor.drag") {
    auto to_x = input.FindInt("toX");
    auto to_y = input.FindInt("toY");
    if (!to_x || !to_y) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "actor.drag requires integer toX and toY"));
      return;
    }
    action = actor::mojom::ToolAction::NewDragAndRelease(
        actor::mojom::DragAndReleaseAction::New(
            actor::mojom::ToolTarget::NewCoordinateDip(
                gfx::Point(*to_x, *to_y))));
  } else {
    std::move(reply).Run(
        Error("UNKNOWN_TOOL", "Unknown native tool: " + name));
    return;
  }

  // For actor.scroll without an explicit target, default to viewport center.
  if (name == "actor.scroll" && !input.FindInt("nodeId") &&
      !input.FindInt("x") && !input.FindString("selector") &&
      !input.FindString("target")) {
    auto invocation = actor::mojom::ToolInvocation::New();
    invocation->task_id = task_id;
    invocation->target =
        actor::mojom::ToolTarget::NewCoordinateDip(gfx::Point(200, 200));
    invocation->action = std::move(action);
    DispatchActorInvocation(frame_id, std::move(invocation),
                            /*clear_upload_after=*/false, std::move(reply),
                            std::move(set_cancel));
    return;
  }

  ResolveTargetThenRun(
      frame_id, input,
      base::BindOnce(
          [](content::GlobalRenderFrameHostId fid, actor::TaskId tid,
             actor::mojom::ToolActionPtr act, Reply done,
             CancelSetter cancel_setter, actor::mojom::ToolTargetPtr target,
             std::string err) {
            if (!target) {
              std::move(done).Run(Error("TARGET_NOT_FOUND", err));
              return;
            }
            auto invocation = actor::mojom::ToolInvocation::New();
            invocation->task_id = tid;
            invocation->target = std::move(target);
            invocation->action = std::move(act);
            DispatchActorInvocation(fid, std::move(invocation),
                                    /*clear_upload_after=*/false,
                                    std::move(done), std::move(cancel_setter));
          },
          frame_id, task_id, std::move(action), std::move(reply),
          std::move(set_cancel)));
}

}  // namespace

void Dispatch(const SessionContext& session,
              base::DictValue request,
              Reply reply,
              CancelSetter set_cancel) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const std::string* method_ptr = request.FindString("method");
  const base::DictValue* params_ptr = request.FindDict("params");
  if (!method_ptr || !params_ptr) {
    std::move(reply).Run(
        Error("INVALID_REQUEST", "Expected string method and object params"));
    return;
  }
  const std::string& method = *method_ptr;
  const base::DictValue& params = *params_ptr;

  if (method == "browser.info") {
    std::move(reply).Run(Result(base::Value(
        base::DictValue()
            .Set("product", "Dub")
            .Set("protocol", kDubProtocolVersion)
            .Set("chromium", std::string(version_info::GetVersionNumber()))
            .Set("revision", kDubChromiumRevision)
            .Set("buildId", kDubBuildId)
            .Set("instanceId", session.instance_id)
            .Set("profile", session.profile_path)
            .Set("methods", SupportedMethods())
            .Set("tools", SupportedActorTools()))));
    return;
  }

  if (!session.profile) {
    std::move(reply).Run(
        Error("PROFILE_GONE", "Selected Dub profile is no longer available"));
    return;
  }

  if (method == "profile.info") {
    base::DictValue info;
    info.Set("path", session.profile_path);
    info.Set("name", session.profile->GetBaseName().value());
    info.Set("instanceId", session.instance_id);
    info.Set("offTheRecord", session.profile->IsOffTheRecord());
    std::move(reply).Run(Result(base::Value(std::move(info))));
    return;
  }

  if (method == "net.set") {
    std::string err;
    base::DictValue res =
        DubNetworkManager::GetInstance().SetRule(params, &err);
    if (!err.empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", err));
      return;
    }
    std::move(reply).Run(Result(base::Value(std::move(res))));
    return;
  }

  if (method == "net.list") {
    std::move(reply).Run(
        Result(base::Value(DubNetworkManager::GetInstance().ListRules())));
    return;
  }

  if (method == "net.remove") {
    const auto* id = params.FindString("id");
    if (!id || id->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected rule id"));
      return;
    }
    base::DictValue out;
    if (!DubNetworkManager::GetInstance().RemoveRule(*id, &out)) {
      std::move(reply).Run(Error("RULE_NOT_FOUND", "Unknown rule id: " + *id));
      return;
    }
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return;
  }

  if (method == "net.log") {
    const std::string match =
        params.FindString("match") ? *params.FindString("match") : "";
    const int since = params.FindInt("since").value_or(0);
    if (since < 0) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "since must be a non-negative integer"));
      return;
    }
    std::move(reply).Run(Result(base::Value(
        DubNetworkManager::GetInstance().ReadLog(match, static_cast<uint64_t>(since)))));
    return;
  }

  if (method == "profile.clear") {
    uint32_t mask = 0;
    const auto* types = params.FindList("types");
    if (!types || types->empty()) {
      mask = content::StoragePartition::REMOVE_DATA_MASK_COOKIES |
             content::StoragePartition::REMOVE_DATA_MASK_LOCAL_STORAGE |
             content::StoragePartition::REMOVE_DATA_MASK_INDEXEDDB |
             content::StoragePartition::REMOVE_DATA_MASK_CACHE_STORAGE |
             content::StoragePartition::REMOVE_DATA_MASK_SERVICE_WORKERS;
    } else {
      for (const auto& t : *types) {
        if (!t.is_string()) {
          continue;
        }
        const std::string& s = t.GetString();
        if (s == "cookies") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_COOKIES;
        } else if (s == "localStorage") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_LOCAL_STORAGE;
        } else if (s == "indexedDB") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_INDEXEDDB;
        } else if (s == "cache") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_CACHE_STORAGE;
        } else if (s == "serviceWorkers") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_SERVICE_WORKERS;
        } else if (s == "all") {
          mask |= content::StoragePartition::REMOVE_DATA_MASK_ALL;
        } else {
          std::move(reply).Run(
              Error("INVALID_PARAMS", "Unknown storage type: " + s));
          return;
        }
      }
    }
    auto* partition = session.profile->GetDefaultStoragePartition();
    partition->ClearData(
        mask, /*filter_builder=*/nullptr,
        content::StoragePartition::StorageKeyPolicyMatcherFunction(),
        network::mojom::CookieDeletionFilter::New(),
        /*perform_storage_cleanup=*/true, base::Time(), base::Time::Max(),
        base::BindOnce(
            [](Reply done, std::string profile_path, uint32_t cleared_mask) {
              base::DictValue res;
              res.Set("cleared", true);
              res.Set("profile", profile_path);
              res.Set("mask", static_cast<int>(cleared_mask));
              std::move(done).Run(Result(base::Value(std::move(res))));
            },
            std::move(reply), session.profile_path, mask));
    return;
  }

  if (method == "tabs.list") {
    base::ListValue list;
    auto* windows = GlobalBrowserCollection::GetInstance();
    if (windows) {
      windows->ForEach([&](BrowserWindowInterface* window) {
        if (!MatchesSelectedProfile(window, session)) {
          return true;
        }
        auto* model = window->GetTabStripModel();
        if (!model) {
          return true;
        }
        for (int i = 0; i < model->count(); ++i) {
          if (auto* contents = model->GetWebContentsAt(i)) {
            list.Append(Describe({window, contents, i}));
          }
        }
        return true;
      });
    }
    std::move(reply).Run(
        Result(base::Value(base::DictValue().Set("tabs", std::move(list)))));
    return;
  }

  if (method == "tabs.open") {
    const auto* url_str = params.FindString("url");
    if (!url_str || !GURL(*url_str).is_valid()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected a valid URL"));
      return;
    }
    const GURL url(*url_str);
    BrowserWindowInterface* window = FindWindowForProfile(session);
    content::WebContents* created = nullptr;
    if (window) {
      NavigateParams nav_params(window, url, ui::PAGE_TRANSITION_TYPED);
      nav_params.disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
      Navigate(&nav_params);
      created = nav_params.navigated_or_inserted_contents;
    } else {
      NavigateParams nav_params(session.profile.get(), url,
                                ui::PAGE_TRANSITION_TYPED);
      nav_params.disposition = WindowOpenDisposition::NEW_WINDOW;
      Navigate(&nav_params);
      created = nav_params.navigated_or_inserted_contents;
      window = FindWindowForProfile(session);
    }
    if (!created || !window || !window->GetTabStripModel()) {
      std::move(reply).Run(
          Error("OPEN_FAILED", "Could not open tab in selected profile"));
      return;
    }
    const int index =
        window->GetTabStripModel()->GetIndexOfWebContents(created);
    if (index == TabStripModel::kNoTab) {
      std::move(reply).Run(
          Error("OPEN_FAILED", "Opened tab is not attached to tab strip"));
      return;
    }
    std::move(reply).Run(
        Result(base::Value(Describe({window, created, index}))));
    return;
  }

  // Validate method name before tab lookup so unknown methods always return
  // METHOD_NOT_FOUND regardless of whether a tab exists.
  const bool is_tab_method =
      method == "tabs.close" || method == "tabs.activate" ||
      method == "tabs.navigate" || method == "page.evaluate" ||
      method == "page.screenshot" || method == "tools.list" ||
      method == "tools.call";
  if (!is_tab_method) {
    std::move(reply).Run(
        Error("METHOD_NOT_FOUND", "Native method is not implemented: " + method));
    return;
  }

  if (method == "tabs.navigate") {
    const auto* url = params.FindString("url");
    if (!url || !GURL(*url).is_valid()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected a valid URL"));
      return;
    }
  } else if (method == "page.evaluate") {
    if (!params.FindString("expression")) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected expression"));
      return;
    }
  } else if (method == "tools.call") {
    const auto* name = params.FindString("name");
    const auto* input = params.FindDict("input");
    if (!name || !input) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "Expected tool name and input object"));
      return;
    }
  }

  const auto id = params.FindInt("tab");
  if (!id || *id <= 0) {
    std::move(reply).Run(Error("INVALID_PARAMS", "Expected positive integer tab"));
    return;
  }
  Tab tab = FindTab(session, *id);
  if (!tab.contents) {
    std::move(reply).Run(
        Error("TAB_NOT_FOUND", "Tab " + std::to_string(*id) + " does not exist"));
    return;
  }

  if (method == "tabs.close") {
    auto* model = tab.window->GetTabStripModel();
    const int index = tab.index;
    // Release raw_ptrs before CloseWebContentsAt, which may synchronously
    // destroy the WebContents and its owning BrowserWindowInterface.
    tab.contents = nullptr;
    tab.window = nullptr;
    model->CloseWebContentsAt(index, CLOSE_NONE);
    std::move(reply).Run(
        Result(base::Value(base::DictValue().Set("closed", *id))));
    return;
  }

  if (method == "tabs.activate") {
    tab.window->GetTabStripModel()->ActivateTabAt(tab.index);
    std::move(reply).Run(Result(base::Value(Describe(tab))));
    return;
  }

  if (method == "tabs.navigate") {
    const std::string& url = *params.FindString("url");
    tab.contents->GetController().LoadURL(
        GURL(url), content::Referrer(), ui::PAGE_TRANSITION_TYPED,
        std::string());
    std::move(reply).Run(Result(base::Value(Describe(tab))));
    return;
  }

  if (method == "page.evaluate") {
    auto* rfh = tab.contents->GetPrimaryMainFrame();
    if (!rfh || !rfh->IsRenderFrameLive()) {
      std::move(reply).Run(Error("FRAME_GONE", "Main frame is not live"));
      return;
    }
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* dub_frame = remote->get();
    dub_frame->Evaluate(
        *params.FindString("expression"),
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](std::unique_ptr<
                       mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                       keep_alive,
                   Reply done, dub::mojom::EvalResultPtr eval) {
                  if (!eval) {
                    std::move(done).Run(Error(
                        "FRAME_GONE", "Renderer closed during evaluation"));
                    return;
                  }
                  if (!eval->ok) {
                    std::move(done).Run(Error(
                        eval->error_code.empty() ? "EVAL_FAILED"
                                                 : eval->error_code,
                        eval->error_message));
                    return;
                  }
                  auto parsed = base::JSONReader::Read(eval->result_json,
                                                       base::JSON_PARSE_RFC);
                  if (!parsed) {
                    std::move(done).Run(
                        Error("EVAL_FAILED", "Could not parse eval JSON"));
                    return;
                  }
                  std::move(done).Run(Result(std::move(*parsed)));
                },
                std::move(remote), std::move(reply)),
            dub::mojom::EvalResultPtr()));
    return;
  }

  if (method == "page.screenshot") {
    auto* view = tab.contents->GetRenderWidgetHostView();
    if (!view) {
      std::move(reply).Run(Error("NO_SURFACE", "Tab has no render surface"));
      return;
    }
    view->CopyFromSurface(
        gfx::Rect(), gfx::Size(), base::Seconds(10),
        base::BindOnce(
            [](Reply done, const content::CopyFromSurfaceResult& copy) {
              if (!copy.has_value()) {
                std::move(done).Run(
                    Error("CAPTURE_FAILED", "Could not copy the tab surface"));
                return;
              }
              auto png =
                  gfx::PNGCodec::EncodeBGRASkBitmap(copy->bitmap, false);
              if (!png) {
                std::move(done).Run(
                    Error("CAPTURE_FAILED", "PNG encoding failed"));
                return;
              }
              base::DictValue val;
              val.Set("mimeType", "image/png");
              val.Set("width", copy->bitmap.width());
              val.Set("height", copy->bitmap.height());
              val.Set("data", base::Base64Encode(*png));
              std::move(done).Run(Result(base::Value(std::move(val))));
            },
            std::move(reply)));
    return;
  }

  if (method == "tools.list") {
    HandleToolsList(tab, std::move(reply));
    return;
  }

  if (method == "tools.call") {
    InvokeTool(session, tab, *params.FindString("name"),
               *params.FindDict("input"), std::move(reply),
               std::move(set_cancel));
    return;
  }
}

}  // namespace dub

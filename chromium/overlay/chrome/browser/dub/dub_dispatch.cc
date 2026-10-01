// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_dispatch.h"

#include <memory>
#include <string>
#include <utility>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/actor.mojom.h"
#include "chrome/common/chrome_render_frame.mojom.h"
#include "components/actor/core/task_id.h"
#include "components/tabs/public/tab_interface.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "ui/gfx/codec/png_codec.h"
#include "url/gurl.h"

namespace dub {
base::DictValue Result(base::Value value) { return base::DictValue().Set("result", std::move(value)); }
base::DictValue Error(const std::string& code, const std::string& message) {
  return base::DictValue().Set("error", base::DictValue().Set("code", code).Set("message", message));
}
namespace {
struct Tab {
  raw_ptr<BrowserWindowInterface> window = nullptr;
  raw_ptr<content::WebContents> contents = nullptr;
  int index = -1;
};
int TabId(content::WebContents* contents) { return tabs::TabInterface::GetFromContents(contents)->GetHandle().raw_value(); }
Tab FindTab(int id) {
  Tab found;
  GlobalBrowserCollection::GetInstance()->ForEach([&](BrowserWindowInterface* window) {
    auto* model = window->GetTabStripModel();
    for (int i = 0; i < model->count(); ++i) {
      auto* contents = model->GetWebContentsAt(i);
      if (TabId(contents) == id) { found = {window, contents, i}; return false; }
    }
    return true;
  });
  return found;
}
base::DictValue Describe(const Tab& tab) {
  return base::DictValue().Set("id", TabId(tab.contents))
      .Set("url", tab.contents->GetVisibleURL().spec())
      .Set("title", base::UTF16ToUTF8(tab.contents->GetTitle()))
      .Set("active", tab.window->GetTabStripModel()->active_index() == tab.index)
      .Set("loading", tab.contents->IsLoading());
}
base::ListValue Methods() {
  base::ListValue methods;
  for (auto* method : {"browser.info", "tabs.list", "tabs.open", "tabs.close", "tabs.activate", "tabs.navigate", "page.evaluate", "page.screenshot", "tools.call"}) methods.Append(method);
  return methods;
}
void InvokeActor(const Tab& tab, const std::string& name, const base::DictValue& input, Reply reply) {
  auto invocation = actor::mojom::ToolInvocation::New();
  invocation->task_id = actor::TaskId(1);
  if (auto node = input.FindInt("nodeId")) {
    invocation->target = actor::mojom::ToolTarget::NewDomNodeId(*node);
  } else if (auto x = input.FindInt("x"); x && input.FindInt("y")) {
    invocation->target = actor::mojom::ToolTarget::NewCoordinateDip(gfx::Point(*x, *input.FindInt("y")));
  } else if (name.starts_with("page.")) {
    invocation->target = actor::mojom::ToolTarget::NewCoordinateDip(gfx::Point());
  } else {
    std::move(reply).Run(Error("INVALID_PARAMS", "Actor requires nodeId or integer x/y coordinates")); return;
  }
  if (name == "actor.click") {
    invocation->action = actor::mojom::ToolAction::NewClick(actor::mojom::ClickAction::New(actor::mojom::ClickType::kLeft, actor::mojom::ClickCount::kSingle));
  } else if (name == "actor.type") {
    const auto* text = input.FindString("text");
    if (!text) { std::move(reply).Run(Error("INVALID_PARAMS", "actor.type requires text")); return; }
    invocation->action = actor::mojom::ToolAction::NewType(actor::mojom::TypeAction::New(actor::mojom::TypeAction::Mode::kDeleteExisting, *text, input.FindBool("enter").value_or(false)));
  } else if (name.starts_with("page.")) {
    std::string arguments;
    if (!base::JSONWriter::Write(input, &arguments)) { std::move(reply).Run(Error("INVALID_PARAMS", "Cannot serialize tool input")); return; }
    invocation->action = actor::mojom::ToolAction::NewScriptTool(actor::mojom::ScriptToolAction::New(name.substr(5), arguments));
  } else {
    std::move(reply).Run(Error("UNKNOWN_TOOL", "Unknown native actor tool: " + name)); return;
  }
  auto remote = std::make_unique<mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>();
  tab.contents->GetPrimaryMainFrame()->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
  auto* render_frame = remote->get();
  render_frame->InvokeTool(std::move(invocation), mojo::WrapCallbackWithDefaultInvokeIfNotRun(
      base::BindOnce([](std::unique_ptr<mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>> keep_alive,
                        Reply done, actor::mojom::ActionResultPtr result) {
        if (!result) { std::move(done).Run(Error("FRAME_GONE", "Renderer closed during actor invocation")); return; }
        if (result->code != actor::mojom::ActionResultCode::kOk) {
          std::move(done).Run(Error("ACTOR_FAILED", result->message)); return;
        }
        auto value = base::DictValue().Set("code", static_cast<int>(result->code)).Set("message", result->message);
        if (result->script_tool_response && result->script_tool_response->result)
          value.Set("output", *result->script_tool_response->result);
        std::move(done).Run(Result(base::Value(std::move(value))));
      }, std::move(remote), std::move(reply)), actor::mojom::ActionResultPtr()));
}
}

void Dispatch(base::DictValue request, Reply reply) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  const auto& method = *request.FindString("method");
  const auto& params = *request.FindDict("params");
  auto* windows = GlobalBrowserCollection::GetInstance();
  if (method == "browser.info") {
    auto* window = windows->GetLastActiveBrowser();
    std::move(reply).Run(Result(base::Value(base::DictValue()
        .Set("product", "Dub").Set("protocol", 1)
        .Set("chromium", std::string(version_info::GetVersionNumber()))
        .Set("revision", "0e331aaf43bf5e1ffe16e65140de2d925c18f0a2")
        .Set("profile", window ? window->GetProfile()->GetPath().value() : "")
        .Set("methods", Methods()))));
    return;
  }
  if (method == "tabs.list") {
    base::ListValue list;
    windows->ForEach([&](BrowserWindowInterface* window) {
      auto* model = window->GetTabStripModel();
      for (int i = 0; i < model->count(); ++i) list.Append(Describe({window, model->GetWebContentsAt(i), i}));
      return true;
    });
    std::move(reply).Run(Result(base::Value(base::DictValue().Set("tabs", std::move(list))))); return;
  }
  if (method == "tabs.open") {
    auto* window = windows->GetLastActiveBrowser();
    const auto* url = params.FindString("url");
    if (!window) { std::move(reply).Run(Error("NO_WINDOW", "No browser window exists")); return; }
    if (!url || !GURL(*url).is_valid()) { std::move(reply).Run(Error("INVALID_PARAMS", "Expected a valid URL")); return; }
    auto contents = content::WebContents::Create(content::WebContents::CreateParams(window->GetProfile()));
    auto* raw = contents.get();
    window->GetTabStripModel()->AddWebContents(std::move(contents), -1, ui::PAGE_TRANSITION_TYPED, ADD_ACTIVE);
    raw->GetController().LoadURL(GURL(*url), content::Referrer(), ui::PAGE_TRANSITION_TYPED, std::string());
    std::move(reply).Run(Result(base::Value(Describe({window, raw, window->GetTabStripModel()->GetIndexOfWebContents(raw)})))); return;
  }
  const int id = params.FindInt("tab").value_or(0);
  const Tab tab = FindTab(id);
  if (!tab.contents) { std::move(reply).Run(Error("TAB_NOT_FOUND", "Tab " + std::to_string(id) + " does not exist")); return; }
  if (method == "tabs.close") {
    tab.window->GetTabStripModel()->CloseWebContentsAt(tab.index, CLOSE_NONE);
    std::move(reply).Run(Result(base::Value(base::DictValue().Set("closed", id)))); return;
  }
  if (method == "tabs.activate") {
    tab.window->GetTabStripModel()->ActivateTabAt(tab.index);
    std::move(reply).Run(Result(base::Value(Describe(tab)))); return;
  }
  if (method == "tabs.navigate") {
    const auto* url = params.FindString("url");
    if (!url || !GURL(*url).is_valid()) { std::move(reply).Run(Error("INVALID_PARAMS", "Expected a valid URL")); return; }
    tab.contents->GetController().LoadURL(GURL(*url), content::Referrer(), ui::PAGE_TRANSITION_TYPED, std::string());
    std::move(reply).Run(Result(base::Value(Describe(tab)))); return;
  }
  if (method == "page.evaluate") {
    const auto* expression = params.FindString("expression");
    if (!expression) { std::move(reply).Run(Error("INVALID_PARAMS", "Expected expression")); return; }
    tab.contents->GetPrimaryMainFrame()->ExecuteJavaScriptForTests(base::UTF8ToUTF16(*expression),
        base::BindOnce([](Reply done, base::Value value) { std::move(done).Run(Result(std::move(value))); }, std::move(reply)), 0);
    return;
  }
  if (method == "page.screenshot") {
    auto* view = tab.contents->GetRenderWidgetHostView();
    if (!view) { std::move(reply).Run(Error("NO_SURFACE", "Tab has no render surface")); return; }
    view->CopyFromSurface(gfx::Rect(), gfx::Size(), base::Seconds(5),
        base::BindOnce([](Reply done, const content::CopyFromSurfaceResult& copy) {
          if (!copy.has_value()) { std::move(done).Run(Error("CAPTURE_FAILED", "Could not copy the tab surface")); return; }
          auto png = gfx::PNGCodec::EncodeBGRASkBitmap(copy->bitmap, false);
          if (!png) { std::move(done).Run(Error("CAPTURE_FAILED", "PNG encoding failed")); return; }
          std::move(done).Run(Result(base::Value(base::DictValue().Set("mimeType", "image/png").Set("data", base::Base64Encode(*png)))));
        }, std::move(reply)));
    return;
  }
  if (method == "tools.call") {
    const auto* name = params.FindString("name");
    const auto* input = params.FindDict("input");
    if (!name || !input) { std::move(reply).Run(Error("INVALID_PARAMS", "Expected tool name and input object")); return; }
    InvokeActor(tab, *name, *input, std::move(reply)); return;
  }
  std::move(reply).Run(Error("METHOD_NOT_FOUND", "Native method is not implemented: " + method));
}
}

// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_dispatch.h"

#include <memory>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/dub/dub_build_info.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/actor.mojom.h"
#include "chrome/common/chrome_render_frame.mojom.h"
#include "components/actor/core/task_id.h"
#include "components/tabs/public/tab_interface.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
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

base::ListValue StageAMethods() {
  base::ListValue methods;
  for (const char* method :
       {"browser.info", "tabs.list", "tabs.open", "tabs.close",
        "tabs.activate", "tabs.navigate", "tools.call"}) {
    methods.Append(method);
  }
  return methods;
}

base::ListValue StageATools() {
  base::ListValue tools;
  tools.Append("actor.click");
  return tools;
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

void InvokeActor(const SessionContext& session,
                 const Tab& tab,
                 const std::string& name,
                 const base::DictValue& input,
                 Reply reply,
                 CancelSetter set_cancel) {
  if (name != "actor.click") {
    std::move(reply).Run(
        Error("UNKNOWN_TOOL", "Unsupported native tool in Stage A: " + name));
    return;
  }

  auto invocation = actor::mojom::ToolInvocation::New();
  const actor::TaskId task_id(session.next_task_id.Run());
  invocation->task_id = task_id;

  if (auto node = input.FindInt("nodeId")) {
    invocation->target = actor::mojom::ToolTarget::NewDomNodeId(*node);
  } else if (auto x = input.FindInt("x"); x && input.FindInt("y")) {
    invocation->target = actor::mojom::ToolTarget::NewCoordinateDip(
        gfx::Point(*x, *input.FindInt("y")));
  } else {
    std::move(reply).Run(Error(
        "INVALID_PARAMS", "actor.click requires nodeId or integer x/y coordinates"));
    return;
  }

  invocation->action = actor::mojom::ToolAction::NewClick(
      actor::mojom::ClickAction::New(actor::mojom::ClickType::kLeft,
                                     actor::mojom::ClickCount::kSingle));

  auto* rfh = tab.contents->GetPrimaryMainFrame();
  if (!rfh || !rfh->IsRenderFrameLive()) {
    std::move(reply).Run(Error("FRAME_GONE", "Target main frame is not live"));
    return;
  }
  const content::GlobalRenderFrameHostId frame_id = rfh->GetGlobalId();
  if (set_cancel) {
    std::move(set_cancel)
        .Run(base::BindOnce(&CancelActorInFrame, frame_id, task_id));
  }

  auto remote =
      std::make_unique<mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>();
  rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
  auto* render_frame = remote->get();
  render_frame->InvokeTool(
      std::move(invocation),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](std::unique_ptr<
                     mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>>
                     keep_alive,
                 Reply done, actor::mojom::ActionResultPtr result) {
                if (!result) {
                  std::move(done).Run(Error(
                      "FRAME_GONE", "Renderer closed during actor invocation"));
                  return;
                }
                if (result->code != actor::mojom::ActionResultCode::kOk) {
                  std::move(done).Run(
                      Error("ACTOR_FAILED", result->message));
                  return;
                }
                auto value =
                    base::DictValue()
                        .Set("code", static_cast<int>(result->code))
                        .Set("message", result->message);
                if (result->script_tool_response &&
                    result->script_tool_response->result) {
                  value.Set("output", *result->script_tool_response->result);
                }
                std::move(done).Run(Result(base::Value(std::move(value))));
              },
              std::move(remote), std::move(reply)),
          actor::mojom::ActionResultPtr()));
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
            .Set("methods", StageAMethods())
            .Set("tools", StageATools()))));
    return;
  }

  if (!session.profile) {
    std::move(reply).Run(
        Error("PROFILE_GONE", "Selected Dub profile is no longer available"));
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
      method == "tabs.navigate" || method == "tools.call";
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

  if (method == "tools.call") {
    InvokeActor(session, tab, *params.FindString("name"),
                *params.FindDict("input"), std::move(reply),
                std::move(set_cancel));
    return;
  }
}

}  // namespace dub

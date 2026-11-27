// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#include "chrome/browser/dub/dub_dispatch_extra.h"

#include <algorithm>
#include <cctype>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/dub/dub_browser_state.h"
#include "chrome/browser/dub/dub_events.h"
#include "chrome/browser/dub/dub_network.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/dub_frame.mojom.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_constants.h"
#include "net/cookies/cookie_options.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_keyboard_event.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "ui/base/base_window.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"

namespace dub {
namespace {

std::string MakeFrameId(content::GlobalRenderFrameHostId id) {
  return base::NumberToString(id.child_id.GetUnsafeValue()) + ":" +
         base::NumberToString(id.frame_routing_id);
}

int TabIdOf(content::WebContents* contents) {
  auto* tab = tabs::TabInterface::GetFromContents(contents);
  return tab ? tab->GetHandle().raw_value() : 0;
}

base::DictValue DescribeTab(BrowserWindowInterface* window,
                            content::WebContents* contents,
                            int index) {
  auto* model = window ? window->GetTabStripModel() : nullptr;
  return base::DictValue()
      .Set("id", TabIdOf(contents))
      .Set("url", contents->GetVisibleURL().spec())
      .Set("title", base::UTF16ToUTF8(contents->GetTitle()))
      .Set("active", model && model->active_index() == index)
      .Set("loading", contents->IsLoading());
}

struct KeySpec {
  int windows_key_code = 0;
  char16_t ch = 0;
  ui::DomCode dom_code = ui::DomCode::NONE;
  ui::DomKey dom_key = ui::DomKey::NONE;
};

KeySpec ResolveKeySpec(const std::string& key) {
  if (key == "Enter") return {ui::VKEY_RETURN, '\r', ui::DomCode::ENTER, ui::DomKey::ENTER};
  if (key == "Tab") return {ui::VKEY_TAB, '\t', ui::DomCode::TAB, ui::DomKey::TAB};
  if (key == "Escape" || key == "Esc") return {ui::VKEY_ESCAPE, 0, ui::DomCode::ESCAPE, ui::DomKey::ESCAPE};
  if (key == "Backspace") return {ui::VKEY_BACK, 0, ui::DomCode::BACKSPACE, ui::DomKey::BACKSPACE};
  if (key == "Delete") return {ui::VKEY_DELETE, 0, ui::DomCode::DEL, ui::DomKey::DEL};
  if (key == "ArrowUp" || key == "Up") return {ui::VKEY_UP, 0, ui::DomCode::ARROW_UP, ui::DomKey::ARROW_UP};
  if (key == "ArrowDown" || key == "Down") return {ui::VKEY_DOWN, 0, ui::DomCode::ARROW_DOWN, ui::DomKey::ARROW_DOWN};
  if (key == "ArrowLeft" || key == "Left") return {ui::VKEY_LEFT, 0, ui::DomCode::ARROW_LEFT, ui::DomKey::ARROW_LEFT};
  if (key == "ArrowRight" || key == "Right") return {ui::VKEY_RIGHT, 0, ui::DomCode::ARROW_RIGHT, ui::DomKey::ARROW_RIGHT};
  if (key == "Home") return {ui::VKEY_HOME, 0, ui::DomCode::HOME, ui::DomKey::HOME};
  if (key == "End") return {ui::VKEY_END, 0, ui::DomCode::END, ui::DomKey::END};
  if (key == "PageUp") return {ui::VKEY_PRIOR, 0, ui::DomCode::PAGE_UP, ui::DomKey::PAGE_UP};
  if (key == "PageDown") return {ui::VKEY_NEXT, 0, ui::DomCode::PAGE_DOWN, ui::DomKey::PAGE_DOWN};
  if (key == "Space" || key == " ") return {ui::VKEY_SPACE, ' ', ui::DomCode::SPACE, ui::DomKey::FromCharacter(' ')};
  if (key.size() == 1) {
    unsigned char c = static_cast<unsigned char>(key[0]);
    const ui::DomKey dk = ui::DomKey::FromCharacter(static_cast<char32_t>(c));
    if (c >= 'a' && c <= 'z') {
      return {ui::VKEY_A + (c - 'a'), static_cast<char16_t>(c), ui::DomCode::NONE, dk};
    }
    if (c >= 'A' && c <= 'Z') {
      return {ui::VKEY_A + (c - 'A'), static_cast<char16_t>(c), ui::DomCode::NONE, dk};
    }
    if (c >= '0' && c <= '9') {
      return {ui::VKEY_0 + (c - '0'), static_cast<char16_t>(c), ui::DomCode::NONE, dk};
    }
    return {static_cast<int>(c), static_cast<char16_t>(c), ui::DomCode::NONE, dk};
  }
  return {0, 0, ui::DomCode::NONE, ui::DomKey::NONE};
}

std::string SameSiteToString(net::CookieSameSite s) {
  switch (s) {
    case net::CookieSameSite::NO_RESTRICTION:
      return "None";
    case net::CookieSameSite::LAX_MODE:
      return "Lax";
    case net::CookieSameSite::STRICT_MODE:
      return "Strict";
    case net::CookieSameSite::UNSPECIFIED:
      return "Unspecified";
  }
  return "Lax";
}

net::CookieSameSite ParseSameSite(const std::string& s) {
  if (s == "None" || s == "none") return net::CookieSameSite::NO_RESTRICTION;
  if (s == "Strict" || s == "strict") return net::CookieSameSite::STRICT_MODE;
  return net::CookieSameSite::LAX_MODE;
}

base::DictValue SerializeCookie(const net::CanonicalCookie& c) {
  base::DictValue d;
  d.Set("name", c.Name());
  d.Set("value", c.Value());
  d.Set("domain", c.Domain());
  d.Set("path", c.Path());
  d.Set("secure", c.SecureAttribute());
  d.Set("httpOnly", c.IsHttpOnly());
  d.Set("sameSite", SameSiteToString(c.SameSite()));
  if (c.IsPersistent()) {
    d.Set("expires", c.ExpiryDate().InSecondsFSinceUnixEpoch());
  }
  return d;
}

}  // namespace

content::RenderFrameHost* ResolveFrameInTab(content::WebContents* contents,
                                            const std::string& frame_id_str) {
  if (!contents) {
    return nullptr;
  }
  if (frame_id_str.empty()) {
    return contents->GetPrimaryMainFrame();
  }
  content::RenderFrameHost* matched = nullptr;
  contents->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
    if (rfh && rfh->IsRenderFrameLive() &&
        MakeFrameId(rfh->GetGlobalId()) == frame_id_str) {
      matched = rfh;
    }
  });
  return matched;
}

bool DispatchNativeKey(content::RenderFrameHost* rfh,
                       const base::DictValue& input,
                       std::string* error) {
  const std::string* key = input.FindString("key");
  if (!key || key->empty()) {
    *error = "actor.key requires a non-empty key string";
    return false;
  }
  auto* rwh = rfh ? rfh->GetRenderWidgetHost() : nullptr;
  if (!rwh) {
    *error = "Target frame has no RenderWidgetHost";
    return false;
  }
  int modifiers = blink::WebInputEvent::kNoModifiers;
  if (input.FindBool("shift").value_or(false)) {
    modifiers |= blink::WebInputEvent::kShiftKey;
  }
  if (input.FindBool("ctrl").value_or(false)) {
    modifiers |= blink::WebInputEvent::kControlKey;
  }
  if (input.FindBool("alt").value_or(false)) {
    modifiers |= blink::WebInputEvent::kAltKey;
  }
  if (input.FindBool("meta").value_or(false)) {
    modifiers |= blink::WebInputEvent::kMetaKey;
  }

  const KeySpec spec = ResolveKeySpec(*key);
  if (spec.windows_key_code == 0 && spec.ch == 0) {
    *error = "Unsupported key name: " + *key;
    return false;
  }

  rwh->Focus();
  const base::TimeTicks now = base::TimeTicks::Now();
  input::NativeWebKeyboardEvent down(
      blink::WebInputEvent::Type::kRawKeyDown, modifiers, now);
  down.windows_key_code = spec.windows_key_code;
  down.native_key_code = spec.windows_key_code;
  down.dom_code = static_cast<int>(spec.dom_code);
  down.dom_key = static_cast<int>(spec.dom_key);
  rwh->ForwardKeyboardEvent(down);

  if (spec.ch != 0 && !(modifiers & (blink::WebInputEvent::kControlKey |
                                     blink::WebInputEvent::kMetaKey |
                                     blink::WebInputEvent::kAltKey))) {
    input::NativeWebKeyboardEvent ch_ev(blink::WebInputEvent::Type::kChar,
                                        modifiers, now);
    ch_ev.windows_key_code = spec.ch;
    ch_ev.dom_code = static_cast<int>(spec.dom_code);
    ch_ev.dom_key = static_cast<int>(spec.dom_key);
    ch_ev.text[0] = spec.ch;
    ch_ev.unmodified_text[0] = spec.ch;
    rwh->ForwardKeyboardEvent(ch_ev);
  }

  input::NativeWebKeyboardEvent up(blink::WebInputEvent::Type::kKeyUp,
                                   modifiers, now);
  up.windows_key_code = spec.windows_key_code;
  up.native_key_code = spec.windows_key_code;
  up.dom_code = static_cast<int>(spec.dom_code);
  up.dom_key = static_cast<int>(spec.dom_key);
  rwh->ForwardKeyboardEvent(up);
  return true;
}

bool IsExtendedTabMethod(const std::string& method) {
  return method == "frames.list" || method == "page.snapshot" ||
         method == "page.console" || method == "page.wait" ||
         method == "page.viewport" || method == "page.emulate" ||
         method == "tabs.back" || method == "tabs.forward" ||
         method == "tabs.reload" || method == "storage.export" ||
         method == "storage.import";
}

bool DispatchExtendedGlobal(const SessionContext& session,
                            const std::string& method,
                            const base::DictValue& params,
                            Reply& reply) {
  if (method == "callback.respond") {
    const std::string* cb_id = params.FindString("callbackId");
    const base::DictValue* decision = params.FindDict("decision");
    if (!cb_id || cb_id->empty() || !decision) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "Expected callbackId and decision object"));
      return true;
    }
    const bool ok = DubEventHub::GetInstance().RespondCallback(
        *cb_id, decision->Clone());
    if (!ok) {
      std::move(reply).Run(
          Error("CALLBACK_NOT_FOUND", "Unknown or expired callback: " + *cb_id));
      return true;
    }
    base::DictValue out;
    out.Set("ok", true);
    out.Set("callbackId", *cb_id);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "callbacks.list") {
    std::move(reply).Run(
        Result(base::Value(DubEventHub::GetInstance().ListPendingCallbacks())));
    return true;
  }

  if (method == "net.config") {
    std::move(reply).Run(
        Result(base::Value(DubNetworkManager::GetInstance().SetConfig(params))));
    return true;
  }

  if (method == "net.inspect") {
    auto seq = params.FindInt("seq");
    if (!seq || *seq <= 0) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected positive integer seq"));
      return true;
    }
    bool found = false;
    base::DictValue entry = DubNetworkManager::GetInstance().InspectEntry(
        static_cast<uint64_t>(*seq), &found);
    if (!found) {
      std::move(reply).Run(
          Error("NOT_FOUND", "Network log seq not found: " + std::to_string(*seq)));
      return true;
    }
    std::move(reply).Run(Result(base::Value(std::move(entry))));
    return true;
  }

  if (method == "net.remove_by_plugin") {
    const std::string* pid = params.FindString("pluginId");
    if (!pid || pid->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected non-empty pluginId"));
      return true;
    }
    std::move(reply).Run(Result(base::Value(
        DubNetworkManager::GetInstance().RemoveByPlugin(*pid))));
    return true;
  }

  if (method == "clipboard.read") {
    auto* cb = ui::Clipboard::GetForCurrentThread();
    if (!cb) {
      std::move(reply).Run(Error("UNAVAILABLE", "Clipboard is unavailable"));
      return true;
    }
    cb->ReadText(
        ui::ClipboardBuffer::kCopyPaste, std::nullopt,
        base::BindOnce(
            [](Reply done, std::u16string text) {
              base::DictValue out;
              out.Set("text", base::UTF16ToUTF8(text));
              std::move(done).Run(Result(base::Value(std::move(out))));
            },
            std::move(reply)));
    return true;
  }

  if (method == "clipboard.write") {
    const std::string* text = params.FindString("text");
    if (!text) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected string text"));
      return true;
    }
    {
      ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
      writer.WriteText(base::UTF8ToUTF16(*text));
    }
    base::DictValue out;
    out.Set("written", true);
    out.Set("length", static_cast<int>(text->size()));
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "dialog.policy") {
    if (!params.FindString("mode")) {
      std::move(reply).Run(
          Result(base::Value(DubDialogManager::GetInstance().GetPolicy())));
      return true;
    }
    std::string err;
    base::DictValue out = DubDialogManager::GetInstance().SetPolicy(params, &err);
    if (!err.empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", err));
      return true;
    }
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "dialog.list") {
    std::move(reply).Run(
        Result(base::Value(DubDialogManager::GetInstance().ListDialogs())));
    return true;
  }

  if (method == "dialog.respond") {
    const std::string* id = params.FindString("id");
    if (!id || id->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected dialog id"));
      return true;
    }
    const bool accept = params.FindBool("accept").value_or(true);
    const std::string prompt =
        params.FindString("promptText") ? *params.FindString("promptText") : "";
    if (!DubDialogManager::GetInstance().RespondDialog(*id, accept, prompt)) {
      std::move(reply).Run(Error("NOT_FOUND", "Unknown dialog id: " + *id));
      return true;
    }
    base::DictValue out;
    out.Set("handled", true);
    out.Set("id", *id);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "downloads.list") {
    DubDownloadTracker::GetInstance().EnsureAttached(session.profile.get());
    std::move(reply).Run(
        Result(base::Value(DubDownloadTracker::GetInstance().ListDownloads())));
    return true;
  }

  if (method == "downloads.config") {
    std::string err;
    base::DictValue out = DubDownloadTracker::GetInstance().Configure(
        session.profile.get(), params, &err);
    if (!err.empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", err));
      return true;
    }
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "downloads.wait") {
    DubDownloadTracker::GetInstance().EnsureAttached(session.profile.get());
    const std::string id_filter =
        params.FindString("id") ? *params.FindString("id") : "";
    DubDownloadTracker::GetInstance().WaitForDownload(
        id_filter,
        base::BindOnce(
            [](Reply done, base::DictValue rec) {
              std::move(done).Run(Result(base::Value(std::move(rec))));
            },
            std::move(reply)));
    return true;
  }

  if (method == "cookies.list") {
    auto* cm = session.profile->GetDefaultStoragePartition()
                   ->GetCookieManagerForBrowserProcess();
    const std::string url_filter =
        params.FindString("url") ? *params.FindString("url") : "";
    cm->GetAllCookies(base::BindOnce(
        [](Reply done, std::string filter_url,
           const std::vector<net::CanonicalCookie>& cookies) {
          GURL filter(filter_url);
          base::ListValue list;
          for (const auto& c : cookies) {
            if (!filter_url.empty() && filter.is_valid() &&
                !c.IsDomainMatch(filter.host())) {
              continue;
            }
            list.Append(SerializeCookie(c));
          }
          base::DictValue out;
          out.Set("cookies", std::move(list));
          std::move(done).Run(Result(base::Value(std::move(out))));
        },
        std::move(reply), url_filter));
    return true;
  }

  if (method == "cookies.set") {
    const std::string* url_str = params.FindString("url");
    const std::string* name = params.FindString("name");
    const std::string* value = params.FindString("value");
    if (!url_str || !GURL(*url_str).is_valid() || !name || name->empty() ||
        !value) {
      std::move(reply).Run(
          Error("INVALID_PARAMS", "cookies.set requires url, name, and value"));
      return true;
    }
    const GURL url(*url_str);
    const std::string domain =
        params.FindString("domain") ? *params.FindString("domain") : "";
    const std::string path =
        params.FindString("path") ? *params.FindString("path") : "/";
    const bool secure =
        params.FindBool("secure").value_or(url.SchemeIsCryptographic());
    const bool http_only = params.FindBool("httpOnly").value_or(false);
    const std::string ss_str =
        params.FindString("sameSite") ? *params.FindString("sameSite") : "Lax";
    base::Time expires;
    if (auto exp = params.FindDouble("expires")) {
      expires = base::Time::FromSecondsSinceUnixEpoch(*exp);
    }
    net::CookieInclusionStatus status;
    auto cookie = net::CanonicalCookie::CreateSanitizedCookie(
        url, *name, *value, domain, path, base::Time::Now(), expires,
        base::Time::Now(), secure, http_only, ParseSameSite(ss_str),
        net::COOKIE_PRIORITY_DEFAULT, std::nullopt, &status);
    if (!cookie) {
      std::move(reply).Run(
          Error("INVALID_COOKIE", "Could not create canonical cookie"));
      return true;
    }
    auto* cm = session.profile->GetDefaultStoragePartition()
                   ->GetCookieManagerForBrowserProcess();
    cm->SetCanonicalCookie(
        *cookie, url, net::CookieOptions::MakeAllInclusive(),
        base::BindOnce(
            [](Reply done, net::CookieAccessResult res) {
              if (!res.status.IsInclude()) {
                std::move(done).Run(
                    Error("COOKIE_REJECTED", "Cookie was rejected by store"));
                return;
              }
              base::DictValue out;
              out.Set("set", true);
              std::move(done).Run(Result(base::Value(std::move(out))));
            },
            std::move(reply)));
    return true;
  }

  if (method == "cookies.delete") {
    auto filter = network::mojom::CookieDeletionFilter::New();
    if (const std::string* name = params.FindString("name");
        name && !name->empty()) {
      filter->cookie_name = *name;
    }
    if (const std::string* url_str = params.FindString("url");
        url_str && GURL(*url_str).is_valid()) {
      filter->url = GURL(*url_str);
    }
    if (const std::string* domain = params.FindString("domain");
        domain && !domain->empty()) {
      filter->host_name = *domain;
    }
    auto* cm = session.profile->GetDefaultStoragePartition()
                   ->GetCookieManagerForBrowserProcess();
    cm->DeleteCookies(
        std::move(filter),
        base::BindOnce(
            [](Reply done, uint32_t count) {
              base::DictValue out;
              out.Set("deleted", static_cast<int>(count));
              std::move(done).Run(Result(base::Value(std::move(out))));
            },
            std::move(reply)));
    return true;
  }

  if (method == "scripts.add") {
    std::string err;
    base::DictValue out = DubScriptRegistry::GetInstance().AddScript(params, &err);
    if (!err.empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", err));
      return true;
    }
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "scripts.remove") {
    const std::string* id = params.FindString("id");
    if (!id || id->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected script id"));
      return true;
    }
    if (!DubScriptRegistry::GetInstance().RemoveScript(*id)) {
      std::move(reply).Run(Error("NOT_FOUND", "Unknown script id: " + *id));
      return true;
    }
    base::DictValue out;
    out.Set("removed", true);
    out.Set("id", *id);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "scripts.list") {
    std::move(reply).Run(
        Result(base::Value(DubScriptRegistry::GetInstance().ListScripts())));
    return true;
  }

  if (method == "scripts.expose") {
    const std::string* name = params.FindString("name");
    if (!name || name->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected function name"));
      return true;
    }
    const std::string pid =
        params.FindString("pluginId") ? *params.FindString("pluginId") : "";
    std::move(reply).Run(Result(base::Value(
        DubScriptRegistry::GetInstance().ExposeFunction(*name, pid))));
    return true;
  }

  if (method == "scripts.unexpose") {
    const std::string* name = params.FindString("name");
    if (!name || name->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected function name"));
      return true;
    }
    DubScriptRegistry::GetInstance().UnexposeFunction(*name);
    base::DictValue out;
    out.Set("unexposed", true);
    out.Set("name", *name);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "scripts.remove_by_plugin") {
    const std::string* pid = params.FindString("pluginId");
    if (!pid || pid->empty()) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected pluginId"));
      return true;
    }
    const int removed = DubScriptRegistry::GetInstance().RemoveByPlugin(*pid);
    base::DictValue out;
    out.Set("pluginId", *pid);
    out.Set("removed", removed);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  return false;
}

bool DispatchExtendedTab(const SessionContext& session,
                         const std::string& method,
                         const base::DictValue& params,
                         BrowserWindowInterface* window,
                         content::WebContents* contents,
                         int tab_index,
                         Reply& reply) {
  DubTabObserver* observer = DubTabObserver::EnsureForWebContents(contents);

  if (method == "frames.list") {
    base::ListValue frames;
    contents->ForEachRenderFrameHost([&](content::RenderFrameHost* rfh) {
      if (!rfh || !rfh->IsRenderFrameLive()) {
        return;
      }
      base::DictValue f;
      f.Set("frameId", MakeFrameId(rfh->GetGlobalId()));
      if (auto* parent = rfh->GetParent()) {
        f.Set("parentFrameId", MakeFrameId(parent->GetGlobalId()));
      }
      f.Set("url", rfh->GetLastCommittedURL().spec());
      f.Set("name", rfh->GetFrameName());
      f.Set("isMainFrame", rfh->IsInPrimaryMainFrame());
      frames.Append(std::move(f));
    });
    base::DictValue out;
    out.Set("tab", TabIdOf(contents));
    out.Set("frames", std::move(frames));
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "page.console") {
    const int since = params.FindInt("since").value_or(0);
    const std::string level =
        params.FindString("level") ? *params.FindString("level") : "";
    const bool clear = params.FindBool("clear").value_or(false);
    std::move(reply).Run(Result(base::Value(observer->ReadConsole(
        static_cast<uint64_t>(std::max(0, since)), level, clear))));
    return true;
  }

  if (method == "page.snapshot") {
    const std::string frame_id =
        params.FindString("frameId") ? *params.FindString("frameId") : "";
    auto* rfh = ResolveFrameInTab(contents, frame_id);
    if (!rfh || !rfh->IsRenderFrameLive()) {
      std::move(reply).Run(Error("FRAME_GONE", "Target frame is not live"));
      return true;
    }
    const uint32_t max_nodes =
        static_cast<uint32_t>(std::clamp(params.FindInt("maxNodes").value_or(300), 1, 2000));
    const bool include_hidden = params.FindBool("includeHidden").value_or(false);
    const std::string fid_str = MakeFrameId(rfh->GetGlobalId());
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* ptr = remote->get();
    ptr->Snapshot(
        max_nodes, include_hidden,
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](std::unique_ptr<
                       mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                       keep_alive,
                   std::string fid, Reply done, const std::string& json) {
                  auto parsed = base::JSONReader::ReadDict(
                      json, base::JSON_PARSE_RFC);
                  if (!parsed) {
                    std::move(done).Run(
                        Error("SNAPSHOT_FAILED", "Could not parse snapshot"));
                    return;
                  }
                  parsed->Set("frameId", fid);
                  std::move(done).Run(Result(base::Value(std::move(*parsed))));
                },
                std::move(remote), fid_str, std::move(reply)),
            std::string()));
    return true;
  }

  if (method == "page.wait") {
    const std::string frame_id =
        params.FindString("frameId") ? *params.FindString("frameId") : "";
    auto* rfh = ResolveFrameInTab(contents, frame_id);
    if (!rfh || !rfh->IsRenderFrameLive()) {
      std::move(reply).Run(Error("FRAME_GONE", "Target frame is not live"));
      return true;
    }
    const std::string selector =
        params.FindString("selector") ? *params.FindString("selector") : "";
    const std::string text =
        params.FindString("text") ? *params.FindString("text") : "";
    const std::string expression =
        params.FindString("expression") ? *params.FindString("expression") : "";
    const std::string state =
        params.FindString("state") ? *params.FindString("state") : "visible";
    const uint32_t timeout_ms = static_cast<uint32_t>(
        std::clamp(params.FindInt("timeoutMs").value_or(10000), 50, 120000));
    if (selector.empty() && text.empty() && expression.empty()) {
      std::move(reply).Run(Error(
          "INVALID_PARAMS",
          "page.wait requires selector, text, or expression"));
      return true;
    }
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* ptr = remote->get();
    ptr->WaitFor(
        selector, text, expression, state, timeout_ms,
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](std::unique_ptr<
                       mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                       keep_alive,
                   Reply done, bool ok, const std::string& detail_json,
                   const std::string& err) {
                  if (!ok) {
                    std::move(done).Run(Error(
                        "WAIT_TIMEOUT",
                        err.empty() ? "Timed out waiting for condition" : err));
                    return;
                  }
                  auto parsed = base::JSONReader::Read(detail_json,
                                                       base::JSON_PARSE_RFC);
                  base::DictValue out;
                  out.Set("ok", true);
                  if (parsed) {
                    out.Set("detail", std::move(*parsed));
                  }
                  std::move(done).Run(Result(base::Value(std::move(out))));
                },
                std::move(remote), std::move(reply)),
            false, "{}", "Renderer closed during wait"));
    return true;
  }

  if (method == "page.viewport") {
    auto width = params.FindInt("width");
    auto height = params.FindInt("height");
    if (width && height) {
      if (*width < 100 || *width > 7680 || *height < 100 || *height > 4320) {
        std::move(reply).Run(
            Error("INVALID_PARAMS", "Viewport dimensions out of bounds"));
        return true;
      }
      if (window && window->GetWindow()) {
        gfx::Rect bounds = window->GetWindow()->GetBounds();
        bounds.set_width(*width);
        bounds.set_height(*height);
        window->GetWindow()->SetBounds(bounds);
      }
    }
    gfx::Size sz;
    if (auto* view = contents->GetRenderWidgetHostView()) {
      sz = view->GetVisibleViewportSize();
    }
    base::DictValue out;
    out.Set("width", sz.width());
    out.Set("height", sz.height());
    if (window && window->GetWindow()) {
      gfx::Rect b = window->GetWindow()->GetBounds();
      out.Set("windowWidth", b.width());
      out.Set("windowHeight", b.height());
    }
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "page.emulate") {
    if (const std::string* ua = params.FindString("userAgent");
        ua && !ua->empty()) {
      blink::UserAgentOverride ua_override;
      ua_override.ua_string_override = *ua;
      contents->SetUserAgentOverride(ua_override,
                                     /*override_in_new_tabs=*/false);
    }
    // Build a deterministic per-tab init/immediate script for colorScheme,
    // reducedMotion, geolocation, locale, timezone, and seeded Math.random().
    std::string patch_js = "(() => {";
    if (const std::string* scheme = params.FindString("colorScheme");
        scheme && (*scheme == "dark" || *scheme == "light")) {
      std::string q;
      base::JSONWriter::Write(base::Value(*scheme), &q);
      patch_js +=
          "const __origMM = window.matchMedia && window.matchMedia.bind(window);"
          "if (__origMM) { window.matchMedia = (q) => {"
          "  if (/prefers-color-scheme\\s*:\\s*(dark|light)/i.test(q)) {"
          "    const want = q.toLowerCase().includes(" + q + ");"
          "    return { matches: want, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false;} };"
          "  }"
          "  return __origMM(q);"
          "}; }";
    }
    if (auto seed = params.FindInt("randomSeed")) {
      patch_js +=
          "let __s = " + std::to_string(*seed) + " >>> 0;"
          "Math.random = () => { __s = (__s + 0x6D2B79F5) >>> 0; let t = Math.imul(__s ^ (__s >>> 15), 1 | __s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };";
    }
    if (const base::DictValue* geo = params.FindDict("geolocation")) {
      double lat = geo->FindDouble("latitude").value_or(0.0);
      double lon = geo->FindDouble("longitude").value_or(0.0);
      double acc = geo->FindDouble("accuracy").value_or(10.0);
      patch_js +=
          "if (navigator.geolocation) {"
          "  const __pos = { coords: { latitude: " +
          base::NumberToString(lat) + ", longitude: " +
          base::NumberToString(lon) + ", accuracy: " +
          base::NumberToString(acc) +
          ", altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };"
          "  navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok(__pos), 0);"
          "  navigator.geolocation.watchPosition = (ok) => { setTimeout(() => ok(__pos), 0); return 1; };"
          "}";
    }
    if (const std::string* loc = params.FindString("locale");
        loc && !loc->empty()) {
      std::string q;
      base::JSONWriter::Write(base::Value(*loc), &q);
      patch_js += "Object.defineProperty(navigator, 'language', { get: () => " +
                  q + ", configurable: true });";
    }
    patch_js += "return true; })()";

    auto* rfh = contents->GetPrimaryMainFrame();
    if (rfh && rfh->IsRenderFrameLive()) {
      auto remote =
          std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
      rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
      auto* ptr = remote->get();
      ptr->Evaluate(
          patch_js,
          base::BindOnce(
              [](std::unique_ptr<
                     mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                     keep_alive,
                 Reply done, dub::mojom::EvalResultPtr) {
                base::DictValue out;
                out.Set("emulated", true);
                std::move(done).Run(Result(base::Value(std::move(out))));
              },
              std::move(remote), std::move(reply)));
      return true;
    }
    base::DictValue out;
    out.Set("emulated", true);
    std::move(reply).Run(Result(base::Value(std::move(out))));
    return true;
  }

  if (method == "tabs.back" || method == "tabs.forward" ||
      method == "tabs.reload") {
    auto& controller = contents->GetController();
    const std::string wait_until =
        params.FindString("waitUntil") ? *params.FindString("waitUntil") : "none";
    if (method == "tabs.back") {
      if (controller.CanGoBack()) {
        controller.GoBack();
      }
    } else if (method == "tabs.forward") {
      if (controller.CanGoForward()) {
        controller.GoForward();
      }
    } else {
      const bool ignore_cache = params.FindBool("ignoreCache").value_or(false);
      controller.Reload(
          ignore_cache ? content::ReloadType::BYPASSING_CACHE
                       : content::ReloadType::NORMAL,
          true);
    }
    if (wait_until != "none" && !wait_until.empty()) {
      base::WeakPtr<content::WebContents> wc = contents->GetWeakPtr();
      observer->AddNavigationWaiter(
          wait_until,
          base::BindOnce(
              [](base::WeakPtr<content::WebContents> weak_wc,
                 BrowserWindowInterface* win, int idx, Reply done) {
                if (!weak_wc) {
                  std::move(done).Run(Error("TAB_GONE", "Tab closed during navigation"));
                  return;
                }
                std::move(done).Run(
                    Result(base::Value(DescribeTab(win, weak_wc.get(), idx))));
              },
              wc, window, tab_index, std::move(reply)));
      return true;
    }
    std::move(reply).Run(
        Result(base::Value(DescribeTab(window, contents, tab_index))));
    return true;
  }

  if (method == "storage.export") {
    auto* rfh = contents->GetPrimaryMainFrame();
    if (!rfh || !rfh->IsRenderFrameLive()) {
      std::move(reply).Run(Error("FRAME_GONE", "Main frame is not live"));
      return true;
    }
    const GURL page_url = contents->GetVisibleURL();
    auto* cm = session.profile->GetDefaultStoragePartition()
                   ->GetCookieManagerForBrowserProcess();
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* ptr = remote->get();
    ptr->Evaluate(
        "(() => { const ls = {}, ss = {}; "
        "for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } "
        "for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); } "
        "return { origin: location.origin, localStorage: ls, sessionStorage: ss }; })()",
        mojo::WrapCallbackWithDefaultInvokeIfNotRun(
            base::BindOnce(
                [](std::unique_ptr<
                       mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                       keep_alive,
                   network::mojom::CookieManager* cookie_mgr, GURL url,
                   Reply done, dub::mojom::EvalResultPtr eval) {
                  base::DictValue storage;
                  if (eval && eval->ok) {
                    if (auto parsed = base::JSONReader::ReadDict(
                            eval->result_json, base::JSON_PARSE_RFC)) {
                      storage = std::move(*parsed);
                    }
                  }
                  cookie_mgr->GetAllCookies(base::BindOnce(
                      [](Reply r, base::DictValue st, GURL u,
                         const std::vector<net::CanonicalCookie>& cookies) {
                        base::ListValue clist;
                        for (const auto& c : cookies) {
                          if (!u.is_valid() || c.IsDomainMatch(u.host())) {
                            clist.Append(SerializeCookie(c));
                          }
                        }
                        st.Set("cookies", std::move(clist));
                        std::move(r).Run(Result(base::Value(std::move(st))));
                      },
                      std::move(done), std::move(storage), url));
                },
                std::move(remote), cm, page_url, std::move(reply)),
            dub::mojom::EvalResultPtr()));
    return true;
  }

  if (method == "storage.import") {
    const base::DictValue* state = params.FindDict("state");
    if (!state) {
      std::move(reply).Run(Error("INVALID_PARAMS", "Expected state object"));
      return true;
    }
    auto* rfh = contents->GetPrimaryMainFrame();
    if (!rfh || !rfh->IsRenderFrameLive()) {
      std::move(reply).Run(Error("FRAME_GONE", "Main frame is not live"));
      return true;
    }
    std::string state_json;
    base::JSONWriter::Write(*state, &state_json);
    const std::string apply_js =
        "(() => { const st = " + state_json + ";"
        "if (st.localStorage) for (const [k,v] of Object.entries(st.localStorage)) localStorage.setItem(k, String(v));"
        "if (st.sessionStorage) for (const [k,v] of Object.entries(st.sessionStorage)) sessionStorage.setItem(k, String(v));"
        "return true; })()";
    if (const base::ListValue* cookies = state->FindList("cookies")) {
      auto* cm = session.profile->GetDefaultStoragePartition()
                     ->GetCookieManagerForBrowserProcess();
      const GURL base_url = contents->GetVisibleURL();
      for (const auto& item : *cookies) {
        const auto* cd = item.GetIfDict();
        if (!cd) continue;
        const auto* name = cd->FindString("name");
        const auto* val = cd->FindString("value");
        if (!name || !val) continue;
        const std::string dom =
            cd->FindString("domain") ? *cd->FindString("domain") : "";
        const std::string path =
            cd->FindString("path") ? *cd->FindString("path") : "/";
        const bool sec = cd->FindBool("secure").value_or(false);
        const bool ho = cd->FindBool("httpOnly").value_or(false);
        const std::string ss =
            cd->FindString("sameSite") ? *cd->FindString("sameSite") : "Lax";
        base::Time exp;
        if (auto e = cd->FindDouble("expires")) {
          exp = base::Time::FromSecondsSinceUnixEpoch(*e);
        }
        net::CookieInclusionStatus st;
        if (auto c = net::CanonicalCookie::CreateSanitizedCookie(
                base_url, *name, *val, dom, path, base::Time::Now(), exp,
                base::Time::Now(), sec, ho, ParseSameSite(ss),
                net::COOKIE_PRIORITY_DEFAULT, std::nullopt, &st)) {
          cm->SetCanonicalCookie(*c, base_url,
                                 net::CookieOptions::MakeAllInclusive(),
                                 base::DoNothing());
        }
      }
    }
    auto remote =
        std::make_unique<mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>();
    rfh->GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
    auto* ptr = remote->get();
    ptr->Evaluate(
        apply_js,
        base::BindOnce(
            [](std::unique_ptr<
                   mojo::AssociatedRemote<dub::mojom::DubRenderFrame>>
                   keep_alive,
               Reply done, dub::mojom::EvalResultPtr) {
              base::DictValue out;
              out.Set("imported", true);
              std::move(done).Run(Result(base::Value(std::move(out))));
            },
            std::move(remote), std::move(reply)));
    return true;
  }

  return false;
}

}  // namespace dub

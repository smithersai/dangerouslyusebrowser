// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_DISPATCH_EXTRA_H_
#define CHROME_BROWSER_DUB_DUB_DISPATCH_EXTRA_H_

#include <string>

#include "base/values.h"
#include "chrome/browser/dub/dub_dispatch.h"

class BrowserWindowInterface;

namespace content {
class RenderFrameHost;
class WebContents;
}  // namespace content

namespace dub {

// Dispatches a native keyboard event (RawKeyDown + optional Char + KeyUp)
// with modifiers to the RenderWidgetHost of `rfh`.
bool DispatchNativeKey(content::RenderFrameHost* rfh,
                       const base::DictValue& input,
                       std::string* error);

// Handles non-tab extended methods (clipboard, dialog, downloads, cookies,
// net.config/inspect/removeByPlugin, scripts.*, callback.respond, callbacks.list).
// Returns true if handled.
bool DispatchExtendedGlobal(const SessionContext& session,
                            const std::string& method,
                            const base::DictValue& params,
                            Reply& reply);

// Handles tab-scoped extended methods (frames.list, page.snapshot, page.console,
// page.wait, page.viewport, page.emulate, tabs.back/forward/reload,
// storage.export/import). Returns true if handled.
bool DispatchExtendedTab(const SessionContext& session,
                         const std::string& method,
                         const base::DictValue& params,
                         BrowserWindowInterface* window,
                         content::WebContents* contents,
                         int tab_index,
                         Reply& reply);

// Returns true if `method` is a tab-scoped extended method.
bool IsExtendedTabMethod(const std::string& method);

// Resolves a frameId string ("childId:routingId") within `contents`, or returns
// the primary main frame when `frame_id_str` is empty.
content::RenderFrameHost* ResolveFrameInTab(content::WebContents* contents,
                                            const std::string& frame_id_str);

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_DISPATCH_EXTRA_H_

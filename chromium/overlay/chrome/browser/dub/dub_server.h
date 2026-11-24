// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_SERVER_H_
#define CHROME_BROWSER_DUB_DUB_SERVER_H_

namespace dub {

// Called on the browser UI thread from ChromeBrowserMainParts::PostBrowserStart
// and PostMainMessageLoopRun. No endpoint is created unless --dub-socket is
// supplied on the command line.
void StartServer();
void StopServer();

}  // namespace dub

#endif  // CHROME_BROWSER_DUB_DUB_SERVER_H_

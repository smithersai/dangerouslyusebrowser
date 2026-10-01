// Copyright 2026 The Dub Authors. SPDX-License-Identifier: MIT
#ifndef CHROME_BROWSER_DUB_DUB_SERVER_H_
#define CHROME_BROWSER_DUB_DUB_SERVER_H_
namespace dub {
// Called on the browser UI thread. No endpoint exists without --dub-socket.
void StartServer();
void StopServer();
}
#endif

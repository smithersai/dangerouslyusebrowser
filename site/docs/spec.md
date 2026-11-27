# Dub implementation contract

Dub (DangerouslyUseBrowser) is a real Chromium fork that lets an agent directly control, mock, inspect, and modify browser internals. Run one persistent `dub serve` process; any MCP client connects to its `/mcp` endpoint. The public TypeScript API and incur commands wrap native N-API bindings. Chromium remains a separately sandboxed multiprocess browser.

This contract records the original request, including requirements not yet implemented. It is not a completion claim. Delivery is tracked in [plue#777](https://github.com/smithersai/plue/issues/777); private deployment and commercial details stay in that private issue.

## Required shape

```
LLM / CLI -> incur TypeScript commands -> typed SDK -> N-API addon
                                                    |
                                              native C ABI
                                                    |
                                      private local IPC connection
                                                    |
                                          forked Chromium C++
                                     browser / renderer / network
```

- A true fork: Chromium source may be changed at any seam. No stock-browser, CDP-only, Electron, or CEF substitute.
- N-API is the binding boundary requested by the user. No extra Rust or Zig layer is needed unless it solves a concrete problem.
- A persistent browser session survives independent tool calls and MCP sessions. `dub serve` owns the launched browser and cleans up on shutdown.
- Typed incur commands are exposed over MCP HTTP, with CLI equivalents and useful errors. CLI calls address the running session instead of starting unrelated browsers.
- No per-action confirmation prompts. A separate durable profile is the default; explicit configuration can use an existing compatible profile, with ordinary Chromium profile locking.
- Fail clearly if the fork is absent or has an incompatible protocol. Never silently launch stock Chrome.
- Default listener: loopback. Non-loopback access requires a token. Browser-internal IPC is local and private.

## Three required demos

### 1. Rewrite the network

Mock, block, rewrite, and inspect requests/responses across all tabs, dedicated/shared workers, and service-worker network traffic. Add/remove rules live. Match URLs, return chosen status/headers/body, redirect or modify outgoing requests, replace text in response bodies, and inspect a bounded log. Include service-worker-produced and cache-served responses in the coverage audit; do not claim coverage solely from an HTTP fetch test.

Demonstrations: change an API response to an admin-user fixture; hot-patch a live JavaScript bundle; show the requests affected. A navigation-only interceptor does not satisfy this scope.

### 2. Control the clock

Freeze at a chosen date, advance by a duration (including 31 days), step frames, and resume a selected tab. Verify Date, performance.now(), timers, and animations independently. Define renderer-process sharing and cross-frame/worker semantics explicitly. Do not implement time control by replacing only JavaScript Date.

Demonstrations: exercise trial expiry in seconds and capture an animation one frame at a time. Verify another tab remains unaffected.

### 3. Act as you

Use a persistent real profile. Expose Chromium's actual native actor tools for click, type, navigation, upload, tab selection and related actions, plus discover/invoke tools registered by a page through WebMCP. Do not label DOM click emulation as Chromium actor tools.

Demonstrations: act on a test site's signed-in state, perform a native actor interaction, and discover/invoke a page-registered tool. Development tests use fixture accounts and profiles, not the user's credentials.

## Seam census

Maintain a source-backed map covering network, time, input, rendering, JS engine, storage/profile, tabs/actor, and DevTools/WebMCP. Each entry needs the pinned source path, ownership process/thread, proposed native interface, scope and limits, and the real-browser test proving behavior. Record gaps instead of inventing a completed interface.

## Release gates

1. Reproducible pinned Chromium checkout, overlays/patches, GN build and installation instructions.
2. Native C ABI and N-API build on supported platforms, with transport error, timeout, malformed-input and lifecycle tests.
3. Typed SDK, CLI and actual MCP client tests through incur.
4. Compiled fork end-to-end tests for every claim in all three demos, including workers, profile persistence, time isolation, native actor and WebMCP.
5. Installable package and browser artifact with explicit platform support, checksums and licenses; a clean-machine installation smoke test.
6. A concise README with three working examples, a reproducible local demo, screenshot/video evidence and truthful tweet copy.
7. Source/spec/decisions committed with jj, landed on main and pushed. No private infrastructure details or credentials in public artifacts.

A passing transport fixture is not proof that the browser fork works. An overlay that applies cleanly is not proof that it compiles. A compiled binary is not proof that all advertised browser behavior works. Release readiness requires the actual receipts above.

# First compiled browser slice

Implementation plan against Chromium `0e331aaf43bf5e1ffe16e65140de2d925c18f0a2`. Source inspection supports the integration points below; it does **not** prove compilation or runtime behavior. All remaining work here is tracked in [plue#777](https://github.com/smithersai/plue/issues/777). Implementation is on hold while the build host is settled.

## Patch boundaries

| File / target at the pin | Planned change and reason |
| --- | --- |
| [`chrome/browser/BUILD.gn`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/chrome/browser/BUILD.gn) | Add the four `dub/` overlay files to `source_set("core")`, guarded by `is_linux || is_mac`. This target owns `chrome_browser_main.cc`. `source_set("browser")` aggregates dependencies; do not treat it as the source list. |
| Same file, `browser_public_dependencies` | Check the existing public dependency closure before adding missing external dependencies. The pinned file explicitly routes new external dependencies through this group. Run GN dependency checks; transitive inclusion in a header is not proof of a valid dependency. |
| [`chrome/common/BUILD.gn`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/chrome/common/BUILD.gn) | `:mojo_bindings` owns both `actor.mojom` and `chrome_render_frame.mojom`. Ensure the Dub translation unit has access to their generated headers. No duplicate Mojo interface is needed for the initial actor click. |
| [`chrome/browser/chrome_browser_main.cc`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/chrome/browser/chrome_browser_main.cc) | Call startup at the end of `ChromeBrowserMainParts::PostBrowserStart()`. Stop accepting and invalidate pending browser work at the start of the desktop `PostMainMessageLoopRun()` path, before extra-parts teardown and `browser_process_->StartTearDown()`. Guard includes and calls with the same Linux/macOS platform condition. |
| `chromium/overlay/chrome/browser/dub/` | Add explicit server/session ownership, readiness and request completion. Generate build identity from the checked source manifest rather than trusting the current handwritten revision string. |
| `scripts/chromium.mjs` — to create | Apply an exact-base patch plus overlay; check reapplication and conflicts before GN. Emit a manifest of source hashes and the final diff. The current repository has no runnable script at this path. |

Additional dependency owners to check include [`//ui/gfx/codec`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/ui/gfx/codec/BUILD.gn) for PNG encoding and [`//components/version_info`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/components/version_info/BUILD.gn) for the version facade. Verify generated actor enum names, tab-handle types, callback signatures and direct includes in the actual compile. The GN profile in [build.md](build.md) is still a proposal until generation succeeds.

## Session ownership and readiness

```text
launch -> starting -> ready -> stopping -> stopped
             |          |
             +-> failed <-+  browser exit / failed native health check

owned session:    stopping shuts down its browser process tree
attached session: stopping closes the client/server attachment only
```

The session owns one selected profile. Keep its identity independent of the last active window. Enumerate and resolve tabs within that profile; another profile becoming active must not silently change command scope. The handshake must report the resolved profile path, browser instance ID, Chromium revision, Dub build identity and implemented capabilities. A successful socket connection alone does not mean ready.

`dub serve` must remain usable after its last tab/window closes. Hold a browser keepalive and a selected-profile keepalive while serving; create a window through Chromium's normal navigation path when opening a tab with no window. The pinned [`ScopedKeepAlive`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/components/keep_alive_registry/scoped_keep_alive.h) protects the process, while [`ScopedProfileKeepAlive::TryAcquire`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h) separately protects a regular profile. Neither should be acquired during teardown. Add a Dub origin and update the corresponding enum formatting/metrics definitions without renumbering existing entries. Use the pinned [`ui/navigator/`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/chrome/browser/ui/navigator/) APIs for window creation. Explicit browser quit must still terminate the session and be observed by Node.

Start the HTTP MCP listener only after the native handshake matches the expected build and selected profile. Construct the command catalog from that handshake. A broad `tools.call` method does not imply every actor or page tool exists: tool names need their own supported inventory. First-build exposure is status, tabs and the proven actor click; draft evaluation, screenshot, network, clock and WebMCP handlers stay unadvertised until their tests pass.

Observe browser exit after startup. Health must turn unhealthy and pending callers must fail within their deadlines. Do not silently restart a browser or retry an action that may have run. Run browser cleanup even if HTTP cleanup throws. Attached sessions must never kill a process they did not launch.

Socket cleanup must compare the path's identity with the socket this instance bound; it must not unlink a replacement listener. Serialize competing launch/stale-socket cleanup attempts in the owned private directory. Chromium remains responsible for its profile lock; a second launch must fail clearly rather than attach accidentally through ProcessSingleton.

## Request and shutdown contract

The existing native addon has a whole-call deadline. The draft browser server only bounds reading and writing; a renderer callback can retain a connection indefinitely. Add a server-side request registry before claiming bounded operation.

- Keep protocol 1 framing. Add optional `timeoutMs` to requests, default 30,000, valid integer range 1–300,000. The SDK sends its call limit. The server measures elapsed real monotonic time from acceptance, including queue time; reading a frame also has a five-second ceiling. The client's deadline includes connection time and remains authoritative for that caller.
- Each accepted request owns at most one terminal response. Pending state has a deadline and cancellation path. Bound active connections and queued work; the current limit of 32 is the initial ceiling. Reject overload promptly and release capacity after disconnect, expiry or cancellation.
- Resolve tab/frame identity on the UI sequence. Validate method and parameters before target lookup so an unknown method returns `METHOD_NOT_FOUND`, independent of whether a tab exists. Never carry an unobserved raw tab/frame pointer across asynchronous completion.
- Use weak references or observed lifecycle tokens for native callbacks. Navigation/frame loss, Mojo disconnect and timeout compete through one completion owner; late callbacks must not write a second result or resurrect state.
- Disconnect and timeout cancel pending work where Chromium permits it. Already-dispatched side effects may have happened. Return a terminal error when delivery is possible; transport loss is also a valid terminal failure and never promises rollback.
- On shutdown, stop accepting, mark the session stopping, invalidate dispatch callbacks, cancel native operations and close outstanding descriptors before profile teardown. Do not wait on UI callbacks after the main loop has ended or depend on ThreadPool replies during shutdown. Joining the accept thread alone is insufficient.
- Releasing keepalives and shutting down must be idempotent. Real IPC deadlines must keep advancing while a page clock is frozen.

## First build and proof sequence

1. Apply/check the overlay on the exact pin. Generate GN files with checks enabled, inspect Dub sources/dependencies in `:core`, and compile/link `chrome`. Retain failures and fixes in successive jj commits. A successful object compile without the browser link is insufficient.
2. Launch the compiled fork with a temporary dedicated profile, private socket and sandbox enabled. Record executable SHA-256, Chromium/Dub identities, GN args and runtime method/tool inventory. Verify startup failure for a conflicting profile or live socket.
3. Use a real MCP client through incur, TypeScript and the compiled addon. Open/list/activate/navigate tabs, confirming their state against a local fixture origin. Reject stock Chrome and incompatible handshake identities.
4. Click a fixed-position fixture button through the native actor path. The fixture reports the click event's `isTrusted` and resulting page state to its local server. Assert that observation independently of the command's own success return; a synthetic JavaScript click or a fixture-protocol response cannot pass.
5. Exercise two clients, closing the last window then reopening, renderer destruction during a call, stalled requests exhausting the initial capacity, browser crash and Node shutdown. Assert bounded failures, released capacity, no replacement-socket deletion and no orphan owned browser. Run visible and headless variants where their behavior differs.
6. Save the full browser receipt, then begin the clock-isolation and service-worker-response spikes. Passing this slice does not complete the original three launch demos.

## Other bootstrap gaps recorded for later stages

These were found by reading current source, not by a compiled-browser test:

| Gap | Required follow-up |
| --- | --- |
| `src/launch.ts` checks startup identity but has no post-start browser-exit state; `/health` always reports OK | Implement the session lifecycle above and cover it in BRIDGE-03. |
| `src/http.ts` derives allowed HTTP Host values from the bind address | Define an explicit allowed-host option before claiming wildcard-bind support; `0.0.0.0` does not identify a client's actual destination address. Retain token and Origin enforcement. |
| `package.json` runs `src/cli.ts` for `dev`, but that module only exports `main` and uses compiled `.js` import paths | Make the documented development entry point execute the CLI and validate it without preexisting build output. |
| Package allowlist names absent `binding.gyp`; installation prints build advice and includes no prebuilt addon/browser | Define a complete native build/download/install path, inspect `npm pack` contents, then test the packed package in a fresh environment under INSTALL-01. |
| `tests/browser/` has no suite yet | Implement the real-browser gates; an empty glob or missing `DUB_BROWSER` must never count as a release pass. |

No implementation changes or Chromium builds were made as part of this planning audit.

# Engineering decisions

## 2026-09-30: preserve the fork

The deliverable is Chromium source with native seams, not a CDP automation package. Keep the upstream revision and reproducible overlay in this repository rather than importing Chromium's enormous history. Build from the pinned source plus that overlay. Ordinary Chromium facilities may be reused internally; access is not limited to the public protocol.

## 2026-09-30: N-API over a C ABI, out of process

The Node module exports an asynchronous request API backed by a small C ABI. It talks to a fork-only local endpoint. Chromium runs separately because its process model, UI loop, V8 instance and sandbox must not be embedded into Node's runtime. Native browser dispatch runs on Chromium's UI thread; renderer and network operations cross their normal Mojo boundaries. No remote-debugging port is required.

IPC protocol version 1: one request and one response per AF_UNIX connection, each prefixed by a four-byte unsigned big-endian byte length. Messages are UTF-8 JSON, 1 byte to 16 MiB. Requests contain `{protocol:1, id, method, params}`. Responses echo `id` and contain either `result` or `{error:{code,message}}`. IDs are strings. Enforce a whole-call deadline, not a timeout that resets with each byte. No retries of potentially side-effecting commands.

The caller owns buffers returned by `dub_call` and releases them with `dub_free`. N-API queues blocking native IO off the Node event loop. Native builds use N-API version 8, avoiding Node/V8-version-specific ABI coupling. Initial targets are Linux and macOS; do not claim Windows support until there is an implemented named-pipe transport and build receipt.

## 2026-09-30: network interception belongs below target attachment

The original proposed `content/public/browser/url_loader_request_interceptor.h` explicitly covers navigation requests. It cannot prove all-target interception. Implement global network rules at the network service, using Mojo to update policy and receive bounded logs. Separately audit responses synthesized by service workers, memory/disk caches, and non-HTTP loaders. Do not claim these are covered by a network-service-only hook without tests.

## 2026-09-30: time must be scoped and engine-aware

A process-wide `base::subtle::ScopedTimeClockOverrides` is not per-tab time. It can perturb Chromium bookkeeping and other tabs. Use Blink scheduling/virtual-time mechanisms with explicit ownership and verify render-process sharing. Preserve Date, monotonic time, timers and animation coherence; do not fake the feature with a Date shim.

## 2026-09-30: no silent backend substitution

Validate the fork's protocol and capabilities before serving tools. Missing binaries, missing capabilities and native dispatch failures are errors. Fixtures are permitted for bridge/protocol tests and are labeled as such; they cannot satisfy the browser release gates.

## 2026-09-30: version control and evidence

Use jj in a colocated repository. Commit specs, decisions and verified implementation chunks as work proceeds. Keep main current and push main; no persistent side branches. Browser behavior requires receipts from the compiled fork, with source revision and command recorded. Incomplete work remains tracked in [plue#777](https://github.com/smithersai/plue/issues/777).

## 2026-09-30: planning checkpoint before the Chromium build host

The user requested a subagent to find a purchasable bare-metal option and planning work meanwhile. Keep the original build/launch goal active, but focus current work on the source-backed seam census, build sequence and acceptance gates until the build environment is settled. Do not rent or provision a server on the strength of a recommendation. Provider commercial details remain private.

The source census confirms V8 Date uses a platform clock and Blink virtual time uses a process override. The planned clock seam therefore includes page-owned scheduling and an execution-context-aware V8 clock hook, with an early same-renderer isolation spike. Shared/service workers need independent domains because multiple tabs can own them. This is a design to prove in the compiled fork, not a finished implementation.

## 2026-09-30: first-build lifecycle and profile scope

Integrate the initial overlay into `chrome/browser:core`, whose pinned source list owns `chrome_browser_main.cc`. Start at the end of `PostBrowserStart` and invalidate requests before desktop `PostMainMessageLoopRun` teardown. GN and runtime behavior still need verification on the builder.

A serving session owns a selected profile independent of window activation. Keep the process and that regular profile alive when the last window closes, and reopen through Chromium's navigation facilities. Explicit quit still ends the session. An attachment never owns browser termination. Handshake build/profile/instance identity before exposing a capability-derived command catalog.

Bound native completion as well as socket IO. Add optional request `timeoutMs` with a 30-second default and five-minute maximum, a finite pending registry, and one terminal completion per request. Shutdown invalidates callbacks and releases connections before profile destruction. Timeout or disconnect does not imply an action was rolled back and never triggers an automatic retry. The detailed requirements and source references are in [first-build.md](first-build.md); none are claimed implemented by this decision.

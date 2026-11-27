# Acceptance and delivery plan

All incomplete items below belong to [plue#777](https://github.com/smithersai/plue/issues/777). This is the full launch contract, not a list of work claimed done. The original scope is preserved in [spec.md](spec.md).

## Build sequence

| Stage | Work | Exit evidence |
| --- | --- | --- |
| A — bridge | Integrate the native socket server into the pinned Chromium GN/startup graph; status, tabs and one native actor click | Compiled fork → real N-API addon → incur MCP → actual client, with a native click observed in the page |
| B — architecture spikes | Prove per-page clocks in shared renderers; intercept synthetic service-worker responses | Adversarial two-tab clock test and synthetic-response replacement pass in the actual fork |
| C — network | Full request/response rule engine, decoded-body patching, rule lifecycle and logs | All request-origin/cache cases below, including restart recovery |
| D — time | Date/performance/timers/animation consistency, frame stepping, resume and navigation | Coherent selected-tab clock; unaffected control tab and real browser deadlines |
| E — native actions and WebMCP | Actor delegates, targeting, upload; live page-tool catalog and invocation lifecycle | Native actor suite and real registered page tool, including failures/navigation |
| F — lifecycle and packaging | Profile attach/select, crash handling, capability-gated tool catalog, clean install and archives | Fresh-machine install and two-client persistent-session test |
| G — launch | Three reproducible demos, screenshots/video, README and tweet draft | Every claim links to matching real-browser receipts; artifacts downloadable and installable |

Stages B–E share one builder. Do not finish a polished launch page before the risky seams are proven. Independent source work can be concurrent only with explicit delegation; builder mutations/builds stay serialized.

## Exact browser test inventory to implement

| ID | Required proof |
| --- | --- |
| BRIDGE-01 | MCP initialize/list/call reaches the pinned fork; stock Chrome and mismatched protocol are rejected |
| BRIDGE-02 | Two clients share tabs/rules/clock state; one client disconnecting does not stop the session |
| BRIDGE-03 | Browser crash, native request timeout, frame destruction and shutdown yield bounded failures and no orphan browser |
| BRIDGE-04 | Close the last window, retain the selected profile/session, then open a new tab; another profile becoming active cannot change scope |
| BRIDGE-05 | Stalled requests reach the connection limit and expire, restoring capacity; shutdown/disconnect releases pending work and preserves any replacement socket |
| NET-01 | Mock/block/redirect/patch in a top-level navigation and ordinary fetch; selected status/headers/body are actually received |
| NET-02 | Dedicated worker, shared worker and service-worker outbound fetch before and after a rule update |
| NET-03 | Service-worker synthetic Response, CacheStorage reply, HTTP disk cache and Blink memory-cache hit |
| NET-04 | Compressed/chunked body, empty body, binary content, redirect chain, cancellation and body limit; no accidental double patch |
| NET-05 | Rule precedence/remove/list and logs/follow, bounded retention with a gap receipt, network-service crash and policy replay |
| CLOCK-01 | Date.now/new Date, performance.now, timeout/interval at a chosen epoch; 31-day advance fires due work with defined limits |
| CLOCK-02 | Two same-origin tabs confirmed to share a renderer: freezing/advancing one leaves the other on real time |
| CLOCK-03 | rAF and CSS animation each advance exactly the requested frame count; screenshot matches the committed frame |
| CLOCK-04 | Same-origin/cross-origin frames, dedicated workers, navigation/BFCache and resume; independent shared/service-worker domains documented |
| CLOCK-05 | Browser IPC timeouts and network/security housekeeping remain on real time; infinite interval/page loops cannot hang the browser |
| ACTOR-01 | Click/type/navigation/tab activation use native tools and produce expected trusted events and visible state |
| ACTOR-02 | Text/selector targeting resolves the correct node/frame, detects stale targets, and reports Chromium native failure codes |
| ACTOR-03 | Native file-upload flow reads only the explicitly selected fixture and submits the expected bytes |
| WEBMCP-01 | Tools registered before and after connection are listed with current input schemas/frame IDs; removed tools disappear |
| WEBMCP-02 | Complete/error/cancel responses and duplicate names in different frames; return actual outputs and preserve exception details |
| WEBMCP-03 | Navigation invalidates catalog and resolves cross-document execution without leaving an invocation pending |
| PROFILE-01 | Fixture account stays signed in across browser and MCP restart; existing profile lock is respected |
| PROFILE-02 | Explicit profile selection/attach works and default profile remains separate; chosen storage operations are scoped |
| RENDER-01 | PNG decodes with expected dimensions/pixels in headless and visible runs; closed/occluded frame behavior is explicit |
| JS-01 | Promise-aware evaluation, exception/rejection and nonserializable-result errors; navigation/timeout cannot leak pending callbacks |
| INSTALL-01 | Fresh-machine package and browser download/checksum/install; all runtime dependencies/notices present |
| DEMO-01 | Rewrite a fixture API to admin, patch a live JS bundle, inspect log/follow through public commands |
| DEMO-02 | Freeze at an ISO timestamp, advance 31 days, screenshot expiry, step one animation frame |
| DEMO-03 | Select persistent fixture profile, native actor action, discover and execute a registered page tool |

## Tests already executed

`npm run build:native`, `npm run build`, and `npm test` passed on the initial local checkpoint. Eleven tests cover compiled native framing, fragmentation/UTF-8, concurrency, whole-call deadlines, invalid lengths/inputs, SDK envelope identity, real MCP client routing through incur to a protocol fixture, native error propagation, input validation and HTTP host/origin/token handling. These tests do not satisfy any gate that requires a real browser.

The [first-build plan](first-build.md) defines the GN/lifecycle patch points and bounded-request contract for Stage A. These are planned requirements, not completed browser tests.

## API decisions to finish during implementation

- `profile attach --name Default` must have explicit process ownership semantics; choosing a profile at launch is not the full target command.
- `net log --follow` needs a real bounded event stream, not repeated snapshots with missing events hidden.
- CLI and MCP catalogs must advertise only capability-handshaken native methods. Current wrappers include planned commands whose browser handlers are not implemented.
- Native completion needs a consistent result/error contract. Navigation and side-effect timeouts must not imply rollback; never automatically retry an action that may already have run.
- The draft `page.evaluate` entry point does not yet await promises or serialize exceptions; the draft actor bridge lacks the full delegate/task lifecycle and upload/discovery paths.
- Initial Linux artifact support must be stated directly. Building the Node addon on macOS does not make the Chromium fork available on macOS.

## Launch evidence bundle

Record source/overlay/Chromium/toolchain revisions, GN args, native build logs, browser/MCP test results, install logs, screenshots/video and checksums under a dated artifact receipt. README examples and tweet claims must point to that bundle. Keep server access, provider invoices and other private operating details out of public artifacts.

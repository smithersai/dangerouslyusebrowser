# Native seam census

Source baseline: Chromium [`0e331aaf43bf5e1ffe16e65140de2d925c18f0a2`](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2), version 157.0.8082.0. Paths and APIs below were inspected at that revision. These are implementation cards, not verified features. All open work is tracked by [plue#777](https://github.com/smithersai/plue/issues/777).

## 1. Network

- **Ownership:** network service sequence for ordinary HTTP(S); browser and renderer loaders for service-worker responses.
- **Paths:** `services/network/network_context.cc` (`CreateURLLoaderFactory`); `services/network/public/mojom/network_service.mojom`; `chrome/browser/chrome_content_browser_client.cc` (`OnNetworkServiceCreated`); `content/browser/service_worker/service_worker_main_resource_loader.cc`; `content/renderer/service_worker/service_worker_subresource_loader.cc`.
- **Native surface:** `net.set/list/remove/log`; mock, block, outgoing request rewrite and decoded-body text patch. Policy is versioned and owned by the browser; Mojo distributes it to service/renderer consumers. Reinstall the current version after a network-service restart.
- **Design:** insert a factory/client proxy that can substitute responses or transform body pipes without blocking IO. Intercept service-worker synthetic/cache responses at their response delivery seams as well. Tag transformed requests so a fallback or retry does not apply a patch twice. Include memory-cache behavior in the Blink loader audit.
- **Semantics to implement:** deterministic rule precedence; rule IDs; original/final URL and rule-version log receipts; atomic updates; bounded logs; decoded text transformations; corrected content length and encoding headers; unchanged bytes for nonmatching responses. Body size cap and redirect limits must produce explicit errors, not truncation or silent passthrough.
- **Gate:** test navigation, fetch, dedicated/shared worker, service-worker fetch, synthetic Response, CacheStorage and browser cache independently, including an existing worker and a new worker after a live rule update.
- **Size:** medium/large; several process boundaries. The original navigation interceptor is insufficient.

## 2. Time

- **Ownership:** Blink page/frame task queues, workers, V8 execution contexts and the compositor.
- **Paths:** `third_party/blink/renderer/platform/scheduler/public/virtual_time_controller.h`; `.../scheduler/common/process_time_override_coordinator.cc`; `.../scheduler/common/auto_advancing_virtual_time_domain.h`; `.../scheduler/main_thread/main_thread_scheduler_impl.cc`; `third_party/blink/renderer/core/timing/performance.cc`; `.../core/animation/document_timeline.cc`; `.../core/dom/document.h`.
- **Native surface:** `clock.freeze/advance/step/resume`, addressed by stable tab ID. Commands complete after the requested logical-time work/frame is committed, not merely after a scheduling request is enqueued.
- **Finding:** the existing virtual-time controller describes thread scope. Its coordinator installs a process-wide time override. `Performance::now()` reads `base::TimeTicks::Now()`, and the document timeline reads its document's animation clock. A Date-only shim or unmodified process override cannot satisfy the requested semantics.
- **Planned fork design:** introduce a clock domain owned by the controlled page/frame tree, route its timer queues and performance/animation clocks to it, and provide an execution-context-aware V8 wall-clock hook for Date. Preserve the browser's real clock. Dedicated workers inherit their owner's domain; shared/service workers have explicit independent domains because they can serve multiple tabs. The first spike must prove the V8 hook and independent task scheduling before the full clock API is committed.
- **Gate:** same-origin tabs verified to share a renderer; Date/new Date, performance, timeout/interval, requestAnimationFrame and CSS animation; cross-origin frames; navigation and BFCache; resume without backwards monotonic time. An uncontrolled tab and browser deadlines must continue on real time.
- **Size:** largest seam; isolate and prove it early. Do not hide this uncertainty behind the existing CDP virtual-time command.

## 3. Input and native actor tools

- **Ownership:** browser UI thread and renderer main thread, using associated Mojo frame interfaces.
- **Paths:** `chrome/common/chrome_render_frame.mojom` (`InvokeTool`); `chrome/renderer/chrome_render_frame_observer.cc`; `chrome/renderer/actor/tool_executor.cc`; `chrome/browser/actor/tools/*_tool_request.*`; `chrome/browser/actor/tools/file_upload_tool.*`; `content/public/browser/render_widget_host.h`.
- **Native surface:** `tools.call` for actor click, type, scroll, select, drag, navigation, upload and tab activation; separate typed arguments and returned native failure codes. Click/type dispatch is drafted; it is not compiled or runtime verified.
- **Design:** use actual native ToolInvocation/ToolRequest paths. Resolve text/selector targets to stable observed nodes and retain frame identity for time-of-use validation. Browser-owned upload tools need their browser delegate; renderer-only dispatch cannot implement them. Allocate task IDs per invocation and cancel when the frame/tab disappears.
- **Gate:** trusted click and keyboard events, focused input, native failure propagation, a file upload with filename/content checks, stale-node and frame-navigation cases. DOM `.click()` is not evidence of native actor operation.
- **Size:** medium; browser-level lifecycle and observation add work beyond binding the renderer interface.

## 4. Rendering

- **Ownership:** browser UI/Viz and Blink/compositor frame scheduling.
- **Paths:** `content/public/browser/render_widget_host_view.h` (`CopyFromSurface`); `components/viz/common/frame_sinks/copy_output_result.h`; `ui/gfx/codec/png_codec.h`; `third_party/blink/renderer/core/animation/document_timeline.cc`.
- **Native surface:** `page.screenshot`, viewport control, frame-step completion receipts. The screenshot entry point is drafted.
- **Gate:** decode returned PNG, verify dimensions/pixels on the fixture, capture after navigation and after clock stepping, and verify deterministic repeated frames. Test occluded/headless surfaces and failures explicitly.
- **Size:** small for capture; coupled to the clock seam for deterministic frame stepping.

## 5. JavaScript engine

- **Ownership:** a selected frame's main world/V8 isolate, with worker contexts addressed separately.
- **Paths:** `content/public/browser/render_frame_host.h`; `content/public/browser/devtools_agent_host.h`; Blink `ScriptState`/execution-context mapping. Chromium DEPS pins V8 to `e148d55bb3322408d7c2790bce79959082638c1d`. At that pin, [`src/objects/js-objects.cc`](https://chromium.googlesource.com/v8/v8/+/e148d55bb3322408d7c2790bce79959082638c1d/src/objects/js-objects.cc) implements `JSDate::CurrentTimeValue(Isolate*)` by calling the platform wall clock; this was fetched and inspected directly. A context-aware hook is a fork change, not an existing public per-page time API.
- **Native surface:** evaluation with promise completion, exception details, serializable results and explicit frame identity; extension points for deeper V8 inspection.
- **Finding:** the current draft calls `ExecuteJavaScriptForTests`; that alone does not establish promise awaiting or robust exception serialization. Design the result contract before claiming an evaluation tool is complete. Internal DevTools facilities can support debugging; they are not the architecture's capability boundary.
- **Gate:** awaited fetch, thrown exception, rejected promise, cyclic/nonserializable return, navigation while executing and termination of a timed-out operation. Further heap/profiler APIs belong in the census; only advertise implementations with receipts.
- **Size:** medium; context-sensitive Date integration is part of the time spike.

## 6. Storage and profile

- **Ownership:** browser profile and storage partitions; individual storage services remain sandboxed.
- **Paths:** `chrome/browser/profiles/profile_manager.h`; `content/public/browser/storage_partition.h`; Chromium's user-data-dir/profile-directory selection and process-singleton locking.
- **Native surface:** profile identify/select/attach, clear chosen storage, explicit read/write APIs added by storage kind. Persistent separate profile by default. `profile attach` must report whether it reconnects to an existing Dub process or requires a browser restart; never imply attachment to arbitrary running stock Chrome.
- **Gate:** fixture login, cookie/localStorage/IndexedDB persistence across browser restart, exclusive profile lock, clear scoped storage without touching another profile. Real-user credentials are not needed for these tests.
- **Size:** small for launch/profile selection; medium for storage operations.

## 7. Tabs and browser lifecycle

- **Ownership:** browser UI thread.
- **Paths:** `chrome/browser/ui/browser_window/public/global_browser_collection.h`; `chrome/browser/ui/tabs/tab_strip_model.h`; `components/tabs/public/tab_interface.h`; `components/tabs/public/supports_handles.h`; `chrome/browser/chrome_browser_main.cc`.
- **Native surface:** start/status, stable-handle tab list/open/navigate/activate/close, with readiness states. Draft uses real TabInterface handles rather than tab-strip positions.
- **Gate:** two windows, reorder and close tabs, discard/reload, user-initiated navigation, browser crash and shutdown, duplicate server startup, stale socket, closed frame and concurrent callers. Navigation command must define whether it acknowledges start or awaits a selected readiness condition.
- **Size:** small/medium. This is the first compile-and-MCP vertical slice.

## 8. DevTools and WebMCP

- **Ownership:** browser agent hosts and Blink document model contexts.
- **Paths:** `third_party/blink/public/devtools_protocol/domains/WebMCP.pdl`; `third_party/blink/renderer/core/inspector/inspector_web_mcp_agent.cc`; `third_party/blink/renderer/core/exported/web_document.cc`; `chrome/common/chrome_render_frame.mojom`.
- **Native surface:** `tools.list/call`, exposing page tools with input schemas and frame IDs alongside actual actor tools. Reuse `ModelContext::ListTools` and the native execution/result lifecycle, or the internal WebMCP agent host when useful.
- **Finding:** this pinned WebMCP domain does not have `listTools`. Enabling it emits `toolsAdded`; registrations/removals are events. `invokeTool` returns an invocation ID before `toolResponded` supplies the result. The catalog and invocation need lifetime state, not a single fire-and-forget method call.
- **Gate:** pre-existing/dynamic tools, removals, duplicate names in different frames, completed/error/canceled invocation, cross-document result, and navigation invalidating the old catalog. Return actual tool output, not just the invocation ID.
- **Size:** medium.

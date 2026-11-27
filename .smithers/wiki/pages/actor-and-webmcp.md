# Persistent profiles, native actor tools, and WebMCP

DEMO-03 gives agents direct access to real authenticated browser sessions through persistent Chromium profiles, native trusted input, and page-registered WebMCP tools.

## Persistent profile ownership (`src/launch.ts`)

- By default, `dub serve` creates and owns an isolated persistent profile directory so cookies, IndexedDB, and session storage survive browser restarts without touching the user's daily browser.
- Explicit `--profile` or `profile attach` can select an existing compatible Chromium profile. Dub respects Chromium's ordinary profile lock and never extracts, copies, or inspects credential databases during development.
- Closing the last window does not terminate a serving session; the selected profile remains pinned until explicit shutdown (`SIGINT`/`SIGTERM`).

## Native Chromium actor tools

Instead of synthesizing untrusted DOM clicks, Dub invokes Chromium's native actor delegates (`actor.click`, `actor.type`, `actor.select`, `actor.scroll`, `actor.upload_file`, and navigation actions) from the browser process:
- Dispatched events arrive in the page with `isTrusted: true`.
- Text and selector targeting detects stale targets and returns Chromium's native failure codes.
- File upload reads only the explicitly named local fixture path.

## Live WebMCP page tools (`dub_frame.mojom`)

When a web application registers tools through WebMCP (`navigator.modelContext`), Dub's renderer observer (`chromium/overlay/chrome/renderer/dub/dub_render_frame_observer.cc`) tracks tools dynamically across frames and navigations:
- `tools list` returns current tool names, JSON input schemas, and frame IDs.
- `tools call` invokes the registered page handler and preserves structured return values, rejections, and cancellations.
- Cross-document navigation invalidates stale registrations so pending invocations never wedge.

## Related pages

- [[chromium-seams]]
- [[network-and-clock]]
- [[cloud-mcp-and-auth]]

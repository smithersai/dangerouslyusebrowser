# Chromium 157 fork and overlay seams

Upstream Chromium source stays outside this repository. Dub pins an exact revision in `chromium/revision.json` and layers 21 overlay files plus 5 unified patches via `scripts/chromium.mjs`.

## Pinned baseline

- **Version**: `157.0.8082.0`
- **Commit**: `0e331aaf43bf5e1ffe16e65140de2d925c18f0a2`
- **Protocol**: `1`

## Patch series

| Patch | Milestone | Scope |
| --- | --- | --- |
| `0001-stage-a-dub-core.patch` | Stage A | GN integration in `chrome/browser:core`, `PostBrowserStart` socket startup, clean shutdown before profile destruction |
| `0002-milestone-1-renderer-webmcp-upload.patch` | Milestone 1 | Renderer frame observer (`dub_frame.mojom`), promise-aware eval, native actor upload, live WebMCP tool registry |
| `0003-milestone-2-network-interception.patch` | Milestone 2 | NetworkService-level interception (`services/network/dub/`) across tabs, workers, and caches |
| `0004-milestone-3-per-tab-clock.patch` | Milestone 3 | Per-tab isolated V8 and Blink engine clock with frame stepping and monotonic resume |
| `0005-milestone-4-control-events-plugins.patch` | Milestone 4 | Push event stream (`dub_events`), extended control dispatch (`dub_dispatch_extra`), browser state hooks |

## Lifecycle and profile ownership

Following `docs/first-build.md`:

- `dub serve` starts the native socket at the end of `PostBrowserStart` and invalidates pending callbacks before desktop `PostMainMessageLoopRun` teardown.
- A serving session retains its selected profile when the last browser window closes, preventing accidental session loss.
- The runtime capability handshake (`browser.info`) advertises implemented methods and tools so `createCommands()` only exposes capabilities the running binary supports.
- `scripts/verify-overlay.mjs` runs on every `smthrs ci //:overlay-check` and Uphill audit to validate `revision.json`, unified patch headers, non-empty overlay files, and zero private infrastructure leaks.

## Related pages

- [[start-here]]
- [[network-and-clock]]
- [[actor-and-webmcp]]

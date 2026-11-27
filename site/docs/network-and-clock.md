# NetworkService rewrite and per-tab engine clock

Dub's first two flagship proofs attack the two hardest limits of stock browser automation: universal network control and engine-coherent time travel.

## DEMO-01: NetworkService-level interception

Navigation-only hooks miss `fetch`, dedicated workers, shared workers, service workers, and cache hits. Dub installs `DubNetworkInterceptor` directly inside Chromium's NetworkService (`chromium/overlay/services/network/dub/dub_network_interceptor.cc`) synchronized over Mojo from the browser process (`chromium/overlay/chrome/browser/dub/dub_network.cc`).

Verified capabilities (`tests/browser/milestone-2-network.test.mjs`):
- Live rule add, list, remove, and precedence evaluation without restarting tabs.
- Mock responses (status, headers, body/JSON), request blocking, redirects, header mutation, and decoded-body search/replace patching (no double-patching across gzip/chunked streams).
- Coverage across top-level navigation, `fetch`, dedicated/shared/service workers, CacheStorage, and HTTP disk cache.
- Bounded `net log --follow` stream with explicit gap reporting when entries rotate.

## DEMO-02: Per-tab isolated V8 and Blink clock

Process-wide virtual time perturbs Chromium internals and corrupts sibling tabs sharing a renderer process. Dub patches V8 and Blink (`0004-milestone-3-per-tab-clock.patch`) with page-scoped clock domains while keeping browser IPC deadlines and network housekeeping on real monotonic time.

Verified capabilities (`tests/browser/milestone-3-clock.test.mjs`):
- Freeze at an arbitrary ISO epoch (`clock.freeze`) and synchronize `Date.now()`, `new Date()`, `performance.now()`, `setTimeout`, `setInterval`, `requestAnimationFrame`, and CSS animations.
- Advance 31 days (`clock.advance --by 31d`) with bounded interval fire caps so infinite page timers cannot hang the browser.
- Step exact animation frames (`clock.stepFrames`) and verify committed compositor pixel diffs via screenshot.
- Same-renderer isolation: two same-origin tabs verified to share one renderer PID stay independent (tab A freezes/jumps while tab B stays on wall clock).
- DedicatedWorker inheritance and monotonic resume (`clock.resume`).

## Related pages

- [chromium-seams](https://dangerouslyusebrowser.smithers.sh/docs/chromium-seams.md)
- [actor-and-webmcp](https://dangerouslyusebrowser.smithers.sh/docs/actor-and-webmcp.md)
- [plugins-and-triggers](https://dangerouslyusebrowser.smithers.sh/docs/plugins-and-triggers.md)

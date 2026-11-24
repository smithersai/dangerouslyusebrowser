# Dub — DangerouslyUseBrowser

A Chromium fork that gives agents direct access to browser internals through native N-API bindings and an [incur](https://github.com/wevm/incur) MCP server.

```
Agent → dub serve /mcp → incur → TypeScript → N-API → forked Chromium
```

**Status:** Compiled and verified end-to-end on **Linux x86-64** against pinned Chromium `157.0.8082.0` (`0e331aaf43bf`). All 13 bridge/unit tests, all 4 real-browser acceptance suites (headless and visible Xvfb), all 3 launch demos, and standalone packaged-bundle verification pass. See the [2026-11-23 launch evidence bundle](docs/evidence/2026-11-23/README.md).

> **Platform note:** The compiled Chromium fork is currently built and verified for **Linux x86-64**. Building the Node N-API addon on macOS compiles the bridge/SDK only; it does not produce a macOS Chromium binary.

## Verified capabilities

1. **Rewrite the network (`DEMO-01`).** Live mock, block, redirect, and decoded-body patching across tabs, dedicated/shared/service workers, CacheStorage, and HTTP cache, plus bounded `net log --follow`.
2. **Control time (`DEMO-02`).** Per-tab isolated V8 + Blink clock (`Date`, `performance.now()`, timers, `requestAnimationFrame`, CSS animations) that leaves other tabs sharing a renderer on real time, supports 31-day jumps with bounded interval caps, exact frame stepping, and monotonic resume.
3. **Act as you (`DEMO-03`).** Persistent profile ownership (`profile attach`), Chromium's native actor tools (`actor.click`, `actor.type`, `actor.select`, `actor.scroll`, `actor.upload_file`, etc., dispatching `isTrusted: true`), and live WebMCP page-tool discovery/invocation (`tools list` / `tools call`).

## Develop & Test

Node 22+ and a C++ compiler with Node headers:

```sh
npm ci
npm run build:native
npm run typecheck
npm run build
npm test
node bin/dub.mjs --help
```

### Build & package the Chromium fork (Linux x86-64)

```sh
node scripts/chromium.mjs fetch --src ~/chromium/src
node scripts/chromium.mjs apply --src ~/chromium/src
node scripts/chromium.mjs build --src ~/chromium/src
node scripts/chromium.mjs package --src ~/chromium/src --dest dist-release
```

### Run against the compiled fork

```sh
DUB_BROWSER=/path/to/dub-chromium/chrome dub serve --port 7777
# MCP endpoint: http://127.0.0.1:7777/mcp

# Run the real-browser acceptance suite and reproducible launch demos
DUB_BROWSER=/path/to/dub-chromium/chrome npm run test:browser
DUB_BROWSER=/path/to/dub-chromium/chrome node demos/run-demos.mjs
```

On Ubuntu 24.04+ hosts where AppArmor restricts unprivileged user namespaces, install an AppArmor profile granting `userns` to the extracted `chrome` binary path (matching standard Chromium packaging) so the Linux sandbox runs enabled.

Dub defaults to a separate persistent profile and a loopback listener (`127.0.0.1`). Explicit profile selection gives the agent that profile's authority. Actions run without confirmation prompts.

See the [2026-11-23 evidence bundle](docs/evidence/2026-11-23/README.md), [visual build plan](docs/plan.html), [implementation contract](docs/spec.md), [native seam census](docs/seams.md), [decisions](docs/decisions.md), [build plan](docs/build.md), [first-build integration](docs/first-build.md), [acceptance gates](docs/acceptance.md), and [original target examples](docs/target-examples.md).

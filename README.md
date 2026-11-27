# Dub (DangerouslyUseBrowser)

A real Chromium `157.0.8082.0` fork that gives agents direct access to browser internals through native C++20 N-API bindings, single-use sandbox authentication, QuickJS plugins, and an [incur](https://github.com/wevm/incur) MCP server. Built publicly on [Smithers Cloud](https://smithers.sh/smithersai/dangerouslyusebrowser).

```
Agent -> One-Time Auth -> dub serve /mcp -> QuickJS + incur -> C++20 N-API -> Forked Chromium 157
```

**Public Factory & Docs:**
- **Smithers Cloud Factory:** [smithers.sh/smithersai/dangerouslyusebrowser](https://smithers.sh/smithersai/dangerouslyusebrowser) (personalized views for Maintainers, Contributors, and Viewers)
- **Docs & Factory Site:** [dangerouslyusebrowser.smithers.sh](https://dangerouslyusebrowser.smithers.sh)
- **Lighthouse Backpressure Audit:** [dangerouslyusebrowser.smithers.sh/audit](https://dangerouslyusebrowser.smithers.sh/audit)
- **Engineering Wiki & `llms.txt`:** [wiki](https://dangerouslyusebrowser.smithers.sh/wiki) · [llms.txt](https://dangerouslyusebrowser.smithers.sh/llms.txt)
- **Mythical History:** [history](https://dangerouslyusebrowser.smithers.sh/history)
- **Smithers Cloud MCP:** `https://smithers.sh/api/mcp` (configured in [`.mcp.json`](.mcp.json))

**Status:** Compiled and verified end-to-end on **Linux x86-64** against pinned Chromium `157.0.8082.0` (`0e331aaf43bf`). All 37 bridge/unit/fuzz/auth/plugin/factory tests, all 4 real-browser acceptance suites (headless and visible Xvfb), all 3 launch demos, and standalone packaged-bundle verification pass. See the [2026-11-23 launch evidence bundle](docs/evidence/2026-11-23/README.md).

> **Platform note:** The compiled Chromium fork is currently built and verified for **Linux x86-64**. Building the Node N-API addon on macOS compiles the bridge and SDK only.

## Verified capabilities

1. **Rewrite the network (`DEMO-01`).** Live mock, block, redirect, and decoded-body patching across tabs, dedicated/shared/service workers, CacheStorage, and HTTP cache, plus bounded `net log --follow`.
2. **Control time (`DEMO-02`).** Per-tab isolated V8 + Blink clock (`Date`, `performance.now()`, timers, `requestAnimationFrame`, CSS animations) that leaves other tabs sharing a renderer on real time, supports 31-day jumps with bounded interval caps, exact frame stepping, and monotonic resume.
3. **Act as you (`DEMO-03`).** Persistent profile ownership (`profile attach`), Chromium's native actor tools (`actor.click`, `actor.type`, `actor.select`, `actor.scroll`, `actor.upload_file`, dispatching `isTrusted: true`), and live WebMCP page-tool discovery/invocation (`tools list` / `tools call`).
4. **QuickJS code mode, Jev, triggers, and TypeScript plugins (`Milestone 4`).** Live AF_UNIX push streams (`subscribe`), persistent QuickJS REPL realms (`@smthrs/harness`), typed Jev evaluators (`@smthrs/model`), BYO agent adapters, and hot-reloadable TypeScript plugins.
5. **Cloud MCP & One-Time Sandbox Auth.** Loopback default (`127.0.0.1`), Host/Origin pinning, single-use SHA-256 bootstrap tokens (`dub serve --print-one-time-token`, `POST /auth/exchange`), replay rejection, and untrusted scope attenuation.

## Develop, Test & Smithers Cloud CI

Node 22+ and a C++20 compiler with Node headers:

```sh
npm ci
npm run build:native
npm run typecheck
npm run build
npm test
npm run ci            # Incremental smthrs ci //... backed by build.smithers.sh object store
uphill --compact      # Lighthouse-style backpressure audit
node scripts/build-site.mjs
```

### Trust model & shared object store

Non-maintainers and external contributors are encouraged to run tests, Uphill audits, and flows freely. Untrusted runs receive read-only cache access (`SMITHERS_CACHE_READ_TOKEN`) against `https://build.smithers.sh` and never write to the shared object store or bypass protected-path maintainer gates. Merging from Smithers Cloud to GitHub `main` automatically runs trusted CI, updates the shared cache, publishes docs/wiki/history/audit reports, and releases new versions. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Print a one-time auth token for a sandbox or agent

```sh
dub serve --port 7777 --print-one-time-token --sandbox-id ci-42
# Or mint additional tokens from a running server or Smithers gateway:
DUB_TOKEN=... node scripts/mint-sandbox-auth.mjs --principal agent:reviewer --role agent
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
DUB_BROWSER=/path/to/dub-chromium/chrome npm run test:browser
DUB_BROWSER=/path/to/dub-chromium/chrome node demos/run-demos.mjs
```

See the [Engineering Wiki](.smithers/wiki/README.md), [Mythical History](.smithers/wiki/mythical-history.md), [2026-11-23 evidence bundle](docs/evidence/2026-11-23/README.md), [visual build plan](docs/plan.html), [implementation contract](docs/spec.md), [native seam census](docs/seams.md), [decisions](docs/decisions.md), [build plan](docs/build.md), [first-build integration](docs/first-build.md), and [acceptance gates](docs/acceptance.md).

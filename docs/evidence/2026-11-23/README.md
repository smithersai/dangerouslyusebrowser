# Dub Launch Evidence Bundle — 2026-11-23

This receipt records the verified build, test, packaging, and demo evidence for the Linux x86-64 Dub Chromium fork.

## Revisions & Toolchain

- **Dub commit (Milestone 3 verified):** `4d26d0c7`
- **Chromium pinned version:** `157.0.8082.0` (`0e331aaf43bf5e1ffe16e65140de2d925c18f0a2`)
- **Overlay & patches:** 16 overlay files, 4 patches (`0001-stage-a-dub-core.patch`, `0002-milestone-1-renderer-webmcp-upload.patch`, `0003-milestone-2-network-interception.patch`, `0004-milestone-3-per-tab-clock.patch`)
- **Target platform:** Linux `x86_64` (Ubuntu 24.04.5 LTS, Node `v22.23.5`)
- **GN dev profile args (`scripts/chromium.mjs`):**
  - `is_debug = false`
  - `dcheck_always_on = true`
  - `is_component_build = true`
  - `symbol_level = 0`
  - `blink_symbol_level = 0`
  - `v8_symbol_level = 0`
  - `is_official_build = false`
  - `use_thin_lto = false`
  - `enable_nacl = false`
  - `use_remoteexec = false`

## Package & Checksums (`INSTALL-01`)

Packaged via `node scripts/chromium.mjs package`:

- **Tarball:** `dub-chromium-157.0.8082.0-linux-x64.tar.gz` (390 MiB, includes `LICENSE.DUB`, `LICENSE.CHROMIUM`, `dub-overlay-manifest.json`, and runtime shared libraries/resources)
- **Tarball SHA-256:** `a181048f0b5fc0062b0a852e2fec3111e9d851f3a1d14004043f5814a8ec0773`
- **Compiled `chrome` SHA-256:** `3a3d4f1dc00e16a127878f990bb47620539a9132bfc587f5f4df3c407efb2eb5`
- **Fresh-install verification:** Verified `sha256sum -c SHA256SUMS.txt`, extracted tarball outside the Chromium build tree, packed & installed `dangerouslyusebrowser-0.1.0-alpha.1.tgz` (`npm pack` → fresh `npm install` → `build:native` → `dub --help`), and ran the full `npm run test:browser` suite (4/4 passed in 5.62s) against the extracted bundle.

## Test Results

| Suite | Mode | Result | Duration |
| --- | --- | --- | --- |
| `npm run build:native && npm run typecheck && npm run build && npm test` | Linux x86-64 | 13 / 13 passed | 0.55s |
| `npm run test:browser` (Stage A + Milestones 1–3) | Headless (`--headless=new`) | 4 / 4 passed | 5.33s |
| `npm run test:browser` (Stage A + Milestones 1–3) | Visible (`xvfb-run -a`, `DUB_HEADLESS=0`) | 4 / 4 passed | 5.76s |
| `npm run test:browser` (Packaged release bundle) | Headless (`--headless=new`) | 4 / 4 passed | 5.62s |

### Verified Acceptance Gates

- **BRIDGE-01..05 (`tests/browser/stage-a.test.mjs`):** Real compiled Dub fork → N-API → `incur` MCP HTTP server, runtime capability handshake, two concurrent MCP clients, keepalive across last-window close, `/health` 200 → 503 on shutdown, conflicting socket rejection.
- **JS-01, RENDER-01, ACTOR-01..03, WEBMCP-01..03, PROFILE-01..02 (`tests/browser/milestone-1-act.test.mjs`):** Promise-aware `page.evaluate`, PNG screenshot capture, native Chromium actor click/type/select/scroll/file upload (`isTrusted: true`), live WebMCP `tools.list` / `tools.call` across frames & navigation, persistent profile storage & restart survival.
- **NET-01..05 (`tests/browser/milestone-2-network.test.mjs`):** NetworkService-level mock, block, redirect, and decoded-body patching across top-level navigation, `fetch`, dedicated/shared/service workers, CacheStorage, HTTP disk cache, gzip/chunked/binary bodies, rule lifecycle, and bounded `net log --follow` with gap reporting.
- **CLOCK-01..05 (`tests/browser/milestone-3-clock.test.mjs`):** Per-tab isolated V8 + Blink clock (`Date`, `performance.now()`, `setTimeout`/`setInterval`, `requestAnimationFrame`, CSS animations), same-renderer two-tab isolation, DedicatedWorker inheritance, 31-day advance with bounded interval fire cap, exact frame stepping with committed screenshot diff, and monotonic resume.

## Launch Demos (`demos/run-demos.mjs`)

Full structured receipt: [demos-receipt.json](demos-receipt.json).

1. **DEMO-01 — Rewrite the network:** Rewrote `/v1/user` to `role: "admin"` from a fixture file, patched `/static/app.123.js` (`retries:0` → `retries:3`), verified bounded `net_log` follow (4 entries).
   - Screenshot: [demo-01-network-rewrite.png](screenshots/demo-01-network-rewrite.png) (`e965572ad83df683211d44ff07cbf931f237ac793c73ff51c4470cbf62d1277c`)
2. **DEMO-02 — Control the clock:** Froze at `2026-01-01T09:00:00Z`, stepped 1 + 20 animation frames (`box.left` moved to `289.785px`), advanced 31 days (`TRIAL EXPIRED — 2026-01-31` at exact `2026-01-31T09:00:00.000Z`).
   - Active: [demo-02-trial-active.png](screenshots/demo-02-trial-active.png) (`1a329b311203e6ee4bc4689ab9e1d7dc4bf083348f4f8fd18ef0317058290329`)
   - Stepped: [demo-02-stepped-animation.png](screenshots/demo-02-stepped-animation.png) (`f93414a36e200da4115c68fcf0aec5ddd597b4e0f7cba29cf39042e4aebea5f6`)
   - Expired: [demo-02-trial-expired.png](screenshots/demo-02-trial-expired.png) (`3dccee929a8e22cef853fd885183500554f85c90fa22b672d9ede60013e06523`)
3. **DEMO-03 — Act as you:** Signed in to a persistent fixture profile, restarted Dub, verified `profile_attach` + surviving cookie (`signed-in:will`), discovered 9 tools via `tools_list`, invoked WebMCP `page.submit_expense` (`Submitted $42.10 — team lunch`) and native `actor.click` (`Approved (isTrusted=true)`).
   - Screenshot: [demo-03-act-as-you.png](screenshots/demo-03-act-as-you.png) (`38b752a18f310a7d1cca2218afc5922e2386bf3f3348beddabfd0c82e415ab09`)

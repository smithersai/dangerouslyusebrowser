# Mythical History of Dub

A source-grounded chronicle of **Dub (DangerouslyUseBrowser)** built on pinned Chromium `157.0.8082.0` (`0e331aaf43bf`). Every epoch below links directly to committed source files, patches, and dated verification receipts.

## Epochs

### Epoch I: The Seam Census and the C++20 Bridge (2026-09-30)

> **Stage:** Foundation

Dub began with a hard refusal: no stock-CDP wrapper, no Playwright shim, no Electron shell. The first commits carved a minimal C ABI and N-API v8 bridge over AF_UNIX with whole-call deadlines, incur HTTP MCP commands, and a source-backed seam census across 32 pinned Chromium 157 paths.

**Verified commits:**
- `b138b7df` (2026-11-24) feat(release): add dub install auto-downloader, prebuilt N-API binaries, fuzz tests, demo video, and docs site
- `2566fee2` (2026-09-30) docs: specify first Chromium build integration and session lifecycle
- `1d72070b` (2026-09-30) docs: commit source-backed seam census, build plan and full acceptance gates
- `d143978d` (2026-09-30) draft: checkpoint Chromium native dispatcher and local IPC listener

**Key artifacts:** `docs/spec.md`, `docs/seams.md`, `docs/decisions.md`, `docs/first-build.md`, `native/dub.cc`, `native/addon.cc`

### Epoch II: First Light: Compiled Chromium 157 Fork (Stage A) (2026-11-23)

> **Stage:** Compiled Fork

Pinned Chromium 157.0.8082.0 (0e331aaf43bf) compiled cleanly on Linux x86-64 with the Dub native dispatcher wired directly into chrome/browser:core. A real MCP client crossed incur, TypeScript, N-API, and AF_UNIX to dispatch a native trusted click inside the compiled fork.

**Verified commits:**
- `429abfd3` (2026-11-23) feat(stage-a): compile Dub Chromium 157 fork and pass real-browser MCP + actor click suite

**Key artifacts:** `chromium/revision.json`, `chromium/patches/0001-stage-a-dub-core.patch`, `tests/browser/stage-a.test.mjs`

### Epoch III: NetworkService Mastery and Native WebMCP (Milestones 1 and 2) (2026-11-23)

> **Stage:** DEMO-01 & DEMO-03

Dub moved below navigation-only hooks directly into Chromium NetworkService, intercepting tabs, dedicated/shared/service workers, CacheStorage, and HTTP disk cache. Alongside it landed promise-aware evaluation, persistent profile ownership, native actor tools, and live WebMCP page-tool discovery.

**Verified commits:**
- `16d982f0` (2026-11-23) Implement Milestone 1 (eval/screenshot/actor/WebMCP/profile) and Milestone 2 (NetworkService interception)

**Key artifacts:** `chromium/patches/0002-milestone-1-renderer-webmcp-upload.patch`, `chromium/patches/0003-milestone-2-network-interception.patch`, `tests/browser/milestone-1-act.test.mjs`, `tests/browser/milestone-2-network.test.mjs`

### Epoch IV: Bending Time Without Breaking Sibling Tabs (Milestone 3) (2026-11-23)

> **Stage:** DEMO-02

Rejecting process-wide virtual time, Dub patched V8 and Blink with per-tab isolated clock domains. One tab froze at 2026-01-01, stepped exact animation frames, and jumped 31 days into trial expiry while a sibling tab in the exact same renderer process stayed on wall clock.

**Verified commits:**
- `4d26d0c7` (2026-11-23) feat(milestone-3): implement isolated per-tab engine clock across V8 and Blink

**Key artifacts:** `chromium/patches/0004-milestone-3-per-tab-clock.patch`, `tests/browser/milestone-3-clock.test.mjs`, `docs/evidence/2026-11-23/README.md`

### Epoch V: Launch Evidence, Prebuilds, Fuzzing, and Docs Site (2026-11-24)

> **Stage:** v0.1.0-alpha.1

All three reproducible launch demos passed against the packaged 390 MiB Linux x86-64 bundle with SHA-256 checksums, fresh-install verification, prebuilt N-API binaries for macOS arm64 and Linux x64, 4 fuzz suites, and the public site at dangerouslyusebrowser.smithers.sh.

**Verified commits:**
- `b138b7df` (2026-11-24) feat(release): add dub install auto-downloader, prebuilt N-API binaries, fuzz tests, demo video, and docs site
- `06d7c3cc` (2026-11-23) feat(launch): add reproducible demos, launch evidence bundle, and verified README
- `2030aa8b` (2026-09-30) spec: record Dub fork contract, native architecture and release gates

**Key artifacts:** `docs/evidence/2026-11-23/README.md`, `docs/evidence/2026-11-23/demos-receipt.json`, `demos/run-demos.mjs`, `tests/fuzz.test.mjs`

### Epoch VI: QuickJS Code Mode, Jev, Triggers, and Live TS Plugins (Milestone 4) (2026-11-26)

> **Stage:** Programmable Runtime

Chromium gained a live AF_UNIX push event stream (dub_events) feeding a full Smithers-powered runtime: persistent QuickJS REPL realms, typed Jev evaluators, BYO agent adapters, reactive triggers, and hot-reloadable TypeScript plugins.

**Verified commits:**
- `d84fad3e` (2026-11-26) feat(milestone-4): add Chromium push events, Smithers QuickJS code mode, Jev, BYO agent triggers, and TS plugins

**Key artifacts:** `chromium/patches/0005-milestone-4-control-events-plugins.patch`, `src/smithers-runtime.ts`, `src/plugins.ts`, `src/triggers.ts`, `tests/plugins-smithers.test.mjs`

### Epoch VII: The Smithers Cloud Factory Switchover (2026-11-26)

> **Stage:** Public Factory

Dub switched permanently onto Smithers Cloud: incremental smthrs targets backed by the shared build.smithers.sh object store, single-use one-time sandbox auth tokens, strict untrusted-vs-trusted cache isolation, Lighthouse-style Uphill backpressure, personalized Maintainer/Contributor/Viewer views, Obsidian wiki, and automated release and docs pipelines.

**Verified commits:**
- `edd58a7e` (2026-11-27) fix(ci): run Uphill via wevm/uphill@main and npx uphill@0.0.11
- `a60429a1` (2026-11-27) feat(factory): switch Dub onto Smithers Cloud factory, Lighthouse backpressure, one-time sandbox auth, wiki, and Mythical History
- `d84fad3e` (2026-11-26) feat(milestone-4): add Chromium push events, Smithers QuickJS code mode, Jev, BYO agent triggers, and TS plugins

**Key artifacts:** `.smithers/WORKSPACE.ts`, `.smithers/FACTORY.ts`, `.smithers/home.json`, `.agents/uphill/uphill.yaml`, `src/auth.ts`, `site/audit.html`

## Verified Commit Ledger (from `jj log`)

| Commit | Date | Description |
| --- | --- | --- |
| `edd58a7e` | 2026-11-27 | fix(ci): run Uphill via wevm/uphill@main and npx uphill@0.0.11 |
| `a60429a1` | 2026-11-27 | feat(factory): switch Dub onto Smithers Cloud factory, Lighthouse backpressure, one-time sandbox auth, wiki, and Mythical History |
| `d84fad3e` | 2026-11-26 | feat(milestone-4): add Chromium push events, Smithers QuickJS code mode, Jev, BYO agent triggers, and TS plugins |
| `b138b7df` | 2026-11-24 | feat(release): add dub install auto-downloader, prebuilt N-API binaries, fuzz tests, demo video, and docs site |
| `06d7c3cc` | 2026-11-23 | feat(launch): add reproducible demos, launch evidence bundle, and verified README |
| `4d26d0c7` | 2026-11-23 | feat(milestone-3): implement isolated per-tab engine clock across V8 and Blink |
| `16d982f0` | 2026-11-23 | Implement Milestone 1 (eval/screenshot/actor/WebMCP/profile) and Milestone 2 (NetworkService interception) |
| `429abfd3` | 2026-11-23 | feat(stage-a): compile Dub Chromium 157 fork and pass real-browser MCP + actor click suite |
| `2566fee2` | 2026-09-30 | docs: specify first Chromium build integration and session lifecycle |
| `1d72070b` | 2026-09-30 | docs: commit source-backed seam census, build plan and full acceptance gates |
| `d143978d` | 2026-09-30 | draft: checkpoint Chromium native dispatcher and local IPC listener |
| `67c91e7f` | 2026-09-30 | feat: add typed SDK, incur commands, HTTP MCP server and browser lifecycle |
| `79c48d29` | 2026-09-30 | test: verify compiled N-API framing, concurrency, deadlines and errors |
| `2030aa8b` | 2026-09-30 | spec: record Dub fork contract, native architecture and release gates |


# Dub Engineering Wiki

This Obsidian-compatible engineering wiki is the public, source-cited technical guide for **Dub (DangerouslyUseBrowser)** (`smithersai/dangerouslyusebrowser`). Every page is cataloged in [`.smithers/coding-project.json`](../coding-project.json), bound to explicit repository inputs, and published automatically to [dangerouslyusebrowser.smithers.sh/wiki.html](https://dangerouslyusebrowser.smithers.sh/wiki.html) and [llms.txt](https://dangerouslyusebrowser.smithers.sh/llms.txt) on every merge to `main`.

## Architecture at a glance

```
Agent / BYO Client
  |  (One-time auth -> Bearer session token)
  v
dub serve /mcp  (incur HTTP MCP + TokenAuthority + DubRuntime)
  |  (QuickJS REPL / Jev Evaluator / Reactive Triggers / TS Plugins)
  v
Typed TypeScript SDK (src/browser.ts, src/native.ts)
  |  (N-API v8 C++20 addon: native/addon.cc + native/dub.cc)
  v
AF_UNIX Protocol v1 (length-prefixed UTF-8 JSON + push event stream)
  |
  v
Forked Chromium 157.0.8082.0 (Browser / Renderer / NetworkService seams)
```

## Pages

1. [[start-here|Start here]] ([pages/start-here.md](pages/start-here.md)) - System overview and entry points
2. [[native-bridge|C++20 N-API bridge and IPC protocol]] ([pages/native-bridge.md](pages/native-bridge.md)) - Framing, deadlines, push streams, and C ABI safety
3. [[chromium-seams|Chromium 157 fork and overlay seams]] ([pages/chromium-seams.md](pages/chromium-seams.md)) - Pinned revision, five patches, and overlay architecture
4. [[network-and-clock|NetworkService rewrite and per-tab engine clock]] ([pages/network-and-clock.md](pages/network-and-clock.md)) - DEMO-01 and DEMO-02 internals
5. [[actor-and-webmcp|Persistent profiles, native actor tools, and WebMCP]] ([pages/actor-and-webmcp.md](pages/actor-and-webmcp.md)) - DEMO-03 internals
6. [[plugins-and-triggers|QuickJS code mode, Jev, triggers, and TypeScript plugins]] ([pages/plugins-and-triggers.md](pages/plugins-and-triggers.md)) - Milestone 4 runtime
7. [[cloud-mcp-and-auth|Cloud MCP server and one-time sandbox auth]] ([pages/cloud-mcp-and-auth.md](pages/cloud-mcp-and-auth.md)) - Single-use sandbox tokens and Smithers Cloud MCP
8. [[factory-and-trust|Smithers Cloud factory, object store, and trust model]] ([pages/factory-and-trust.md](pages/factory-and-trust.md)) - Incremental builds, untrusted isolation, and Lighthouse backpressure
9. [[mythical-history|Mythical History]] ([mythical-history.md](mythical-history.md)) - Verified chronological chronicle of Dub from `jj` commits and launch receipts

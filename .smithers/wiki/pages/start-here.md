# Start here

Dub (**DangerouslyUseBrowser**) is a real Chromium `157.0.8082.0` fork that exposes browser internals directly to coding agents through native C++20 N-API bindings and an [incur](https://github.com/wevm/incur) MCP server. It is not Playwright, not a stock-CDP wrapper, and not Electron.

```
BYO Agent (Claude Code / Codex / Antigravity)
   |
   +--> Smithers Cloud MCP (https://smithers.sh/api/mcp)
   |       Issues, TODOs, PRs, stacks, flows, shared cache (build.smithers.sh)
   |
   +--> Dub MCP Server (dub serve /mcp, single-use /auth/exchange token)
           |
           v
        incur CLI + QuickJS REPL + Jev + TS Plugins (src/)
           |
           v  C++20 N-API v8 over AF_UNIX (native/dub.cc + addon.cc)
        Forked Chromium 157.0.8082.0 (NetworkService, Per-Tab Clock, Actor, WebMCP)
```

## Why a real Chromium fork

Stock automation protocols sit outside the browser engine's privileged seams. Dub patches Chromium directly at the C++ browser, renderer, V8, Blink, and NetworkService boundaries so agents can:

- Rewrite, block, redirect, and decode-patch network traffic across tabs, dedicated/shared/service workers, CacheStorage, and HTTP cache (`DEMO-01`).
- Freeze, advance by 31 days, and frame-step a single tab's V8 + Blink clock while leaving sibling tabs in the same renderer on real wall time (`DEMO-02`).
- Attach to a persistent profile, dispatch native Chromium actor input (`isTrusted: true`), and call live WebMCP page tools (`DEMO-03`).
- Run persistent QuickJS TypeScript code-mode cells, typed Jev evaluators, reactive push-stream triggers, and hot-reloadable TypeScript plugins (`Milestone 4`).

## Repository map

| Path | Owning layer |
| --- | --- |
| `native/` | C++20 C ABI and N-API v8 bridge (`dub.h`, `dub.cc`, `addon.cc`) |
| `chromium/` | Pinned Chromium `157.0.8082.0` (`revision.json`), 21 overlay files, 5 unified patches |
| `src/` | TypeScript SDK, incur CLI/MCP commands, `TokenAuthority`, HTTP boundary, and `DubRuntime` |
| `tests/` | Unit, fuzz, auth, plugin, and compiled-fork `tests/browser/` acceptance suites |
| `.smithers/` | Smithers Cloud factory (`FACTORY.ts`, `WORKSPACE.ts`, `home.json`, flows, and this wiki) |
| `.agents/uphill/` | Lighthouse-style backpressure audit metrics and baselines |
| `site/` | Public docs, personalized factory UI, live audit report, wiki, and `llms.txt` |

## Evidence rule

Dub separates bridge-fixture tests from compiled-fork browser proofs. Transport fixtures validate N-API framing, deadlines, MCP schemas, auth, and QuickJS runtimes, never Chromium behavior. Compiled-fork browser behavior is verified by `DUB_BROWSER=/path/to/chrome npm run test:browser` and archived under `docs/evidence/2026-11-23/README.md`.

## Related pages

- [[native-bridge]]
- [[chromium-seams]]
- [[cloud-mcp-and-auth]]
- [[factory-and-trust]]

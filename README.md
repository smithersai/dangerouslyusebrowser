# Dub — DangerouslyUseBrowser

A Chromium fork that gives agents direct access to browser internals through native N-API bindings and an [incur](https://github.com/wevm/incur) MCP server.

```
Agent → dub serve /mcp → incur → TypeScript → N-API → forked Chromium
```

**In development.** The native addon and MCP bridge pass 11 tests. The Chromium overlay is a draft and has not been compiled. There is no installable browser release yet.

The three launch demos are:

1. **Rewrite the network.** Mock an API response, patch a live JS bundle, and inspect traffic across tabs and workers.
2. **Control time.** Freeze one tab, advance 31 days, or step an animation by one frame.
3. **Act as you.** Use a persistent profile, Chromium's native actor tools, and page-registered WebMCP tools.

These remain release requirements; the bridge tests do not prove the demos work.

## Develop

Node 22+ and a C++ compiler with Node headers, on Linux or macOS:

```sh
npm ci
npm run build:native
npm run build
npm test
node bin/dub.mjs --help
```

Once the fork is built, the target launch command is:

```sh
DUB_BROWSER=/path/to/dub-chromium dub serve --port 7777
# MCP endpoint: http://127.0.0.1:7777/mcp
```

Dub defaults to a separate persistent profile and a loopback listener. Explicit profile selection gives the agent that profile's authority. Actions run without confirmation prompts.

See the [visual build plan](docs/plan.html), [implementation contract](docs/spec.md), [native seam census](docs/seams.md), [decisions](docs/decisions.md), [build plan](docs/build.md), [first-build integration](docs/first-build.md), [acceptance gates](docs/acceptance.md), and [original target examples](docs/target-examples.md).

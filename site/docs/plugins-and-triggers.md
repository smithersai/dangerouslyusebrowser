# QuickJS code mode, Jev, triggers, and TypeScript plugins

Milestone 4 turns Dub into a programmable browser runtime built directly on Smithers primitives (`@smthrs/harness`, `@smthrs/model`, and `effect`). All five runtime subsystems are composed inside `DubRuntime` (`src/runtime.ts`).

## Smithers QuickJS code mode (`src/smithers-runtime.ts`)

`SmithersCodeRuntime` executes TypeScript and JavaScript cells inside persistent, isolated QuickJS REPL realms (`@smthrs/harness/Sandbox`):
- Cells call Dub browser operations through typed `ctx.call(...)` flows (`tabs.list`, `page.evaluate`, `net.mock`, `clock.advance`, `jev.ask`, `agent.turn`, and more) across primitive JSON boundaries.
- Every cell is bounded by a wall-clock `timeoutMs` and a `maxCalls` budget, preventing runaway scripts from stalling the host.
- Realms retain lexical bindings across frames (`realmId`) and tear down cleanly on `runtime.close()`.

## Typed Jev evaluators (`src/jev.ts`)

`JevClient` wraps `@smthrs/model/Evaluator` so every enumerable browser decision (boolean, choice, or numeric score) runs with typed failure semantics at the seam instead of silent LLM fallback:
- Supports Vercel AI Gateway in production and deterministic scripted evaluators in tests (`Evaluator.layerScripted`).
- Each question instruction is prefixed with its ID to match Smithers StandardFlows conventions.

## Reactive triggers and BYO agent bridge (`src/triggers.ts`, `src/agent-bridge.ts`)

`TriggerEngine` subscribes to Chromium's live push stream (`net.request`, `net.response`, `page.dialog`, `page.navigate`, `page.console`, `page.error`, `download`, `ws.message`, `page.exposed`) and executes three reactive modes:
1. `code`: evaluates a TypeScript cell in QuickJS with `event` injected.
2. `jev`: queries `JevClient` and routes deterministically to a decision, a QuickJS cell, or agent escalation.
3. `agent`: hands off a structured turn to any BYO agent adapter (CLI such as `claude -p`, OpenAI, Anthropic, or webhook HTTP endpoint) with Dub's `/mcp` endpoint attached.

## Hot-reloadable TypeScript plugins (`src/plugins.ts`)

`PluginManager` loads `.ts` or `.js` plugins (`definePlugin`), transpiles TypeScript via Sucrase, supports `--watch` hot-reload, registers custom MCP tools, synthetic WebMCP page tools, command middleware, and network callbacks, and tears down every resource atomically on unload or reload.

## Related pages

- [native-bridge](https://dangerouslyusebrowser.smithers.sh/docs/native-bridge.md)
- [network-and-clock](https://dangerouslyusebrowser.smithers.sh/docs/network-and-clock.md)
- [cloud-mcp-and-auth](https://dangerouslyusebrowser.smithers.sh/docs/cloud-mcp-and-auth.md)

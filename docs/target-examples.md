# Original target API examples

Dub is a Chromium fork that gives agents direct control of the browser's internals. You run `dub serve`, and any LLM connects to it over MCP.

> **Status: spec only. Nothing below is built yet.** The commands are the target API.

```
 Chromium fork            dub core                 dub serve (incur)
┌──────────────┐  C ABI  ┌──────────────┐  calls  ┌──────────────────┐  MCP over HTTP
│ C++ patches  │◄───────►│ Zig/Rust/C++ │◄───────►│ typed commands   │◄──────────────── LLMs
│ at any seam  │   FFI   │ one handle   │         │ /mcp endpoint    │
└──────────────┘         └──────────────┘         └──────────────────┘
```

Dub is a true fork. We write Zig, Rust, or C++ against any part of Chromium, so there is no protocol ceiling.

## Why "dangerously"

`dub` works the way `--dangerously-skip-permissions` works. It runs without confirmation prompts, it can use your real signed-in profile, and it can change anything the browser sees, sends, or believes. Give it a separate profile unless you mean it.

## Run

```sh
npm i -g dangerouslyusebrowser
dub serve --port 7777                  # starts the browser and serves MCP at /mcp

# Connect any MCP client
claude mcp add --transport http dub http://localhost:7777/mcp
```

Every `dub` command below is also an MCP tool on that server. The browser stays up between calls, so tabs, clocks, and rewrites persist across an agent's session.

## 1. Rewrite the network

Mock, block, or rewrite any request or response in every tab, worker, and service worker, before the page sees it.

```sh
# Point the production frontend at a fake API
dub net rewrite --match 'https://api.acme.com/v1/user' --status 200 --body ./fixtures/admin-user.json

# Hot-patch a live JS bundle to test a fix without deploying
dub net patch --match '*/static/app.*.js' --replace 'retries:0' --with 'retries:3'

# Watch what changed
dub net log --match 'api.acme.com' --follow
```

Use it to test frontends against any backend state, reproduce a customer bug, or try a fix on the real site in seconds.

## 2. Control the clock

Freeze, jump, and step time for one tab: `Date`, `performance.now()`, timers, and animations.

```sh
# Test the "your trial ends in 30 days" flow in two seconds
dub clock freeze --tab 1 --at 2026-01-01T09:00:00Z
dub clock advance --tab 1 --by 31d
dub screenshot --tab 1 --out trial-expired.png

# Step animations one frame at a time for deterministic screenshots
dub clock step --tab 1 --frames 1
```

Use it to test expiry, scheduling, and session-timeout logic, and to make screenshots repeatable.

## 3. Act as you

Attach to your real profile and drive it with Chromium's own agent tools, plus any tools the page registers through WebMCP.

```sh
dub profile attach --name Default
dub tools list --tab 1
# → actor.click  actor.type  actor.navigate  actor.upload_file  actor.switch_tab ...
# → page.submit_expense  page.search_flights   (registered by the site via WebMCP)

dub tools call --tab 1 page.submit_expense --input '{"amount":42.10,"memo":"team lunch"}'
dub tools call --tab 1 actor.click --input '{"target":"Approve"}'
```

Use it to let an agent finish real work in the accounts you already use. This is the most dangerous capability, because every action runs as you.

## Where each capability hooks in

| Capability | Chromium seam |
| --- | --- |
| Rewrite the network | `content/public/browser/url_loader_request_interceptor.h`, in the browser process, for all tabs and workers |
| Control the clock | `base/time/time_override.h`, plus a per-tab clock |
| Act as you | `chrome/browser/actor/tools` (click, type, navigate, tabs, upload) and the `WebMCP` DevTools domain |

Seams verified against Chromium 157.0.8082.0.

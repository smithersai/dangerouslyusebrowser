# Cloud MCP server and one-time sandbox auth

Dub dogfoods Smithers Cloud's Bring-Your-Own-Agent (BYOA) MCP architecture in both directions: agents developing Dub connect to **Smithers Cloud MCP** (`https://smithers.sh/api/mcp`), and agents driving a browser connect to **Dub's authenticated HTTP MCP server** (`dub serve /mcp`) using short-lived, single-use sandbox tokens.

## One-time sandbox authentication (`src/auth.ts`, `src/http.ts`)

```
Maintainer / Controller                      Sandbox / BYO Agent
        |                                             |
        |-- POST /auth/one-time-tokens -------------> | (receives dub_ott_... ONCE)
        |                                             |
        |                                POST /auth/exchange {"token":"dub_ott_..."}
        |                                             |---> atomic single-use mark
        |                                             |<--- dub_ses_... (scoped TTL)
        |                                             |
        |                                POST /mcp (Authorization: Bearer dub_ses_...)
        |                                             |---> verified X-Dub-Trust header
```

Security invariants verified by `tests/auth.test.mjs` and 200 randomized fuzz trials in `tests/fuzz.test.mjs`:
- **Loopback default**: `dub serve` binds `127.0.0.1` by default and refuses non-loopback hosts without authentication.
- **Host and Origin pinning**: Every HTTP request is checked against the allowed Host allowlist and same-origin policy, blocking DNS rebinding and cross-site requests.
- **SHA-256 hashed storage + timing-safe comparison**: Raw `dub_ott_...` and `dub_ses_...` secrets are never stored in memory or logs. Only SHA-256 digests are retained and compared via `crypto.timingSafeEqual`.
- **Atomic single-use redemption**: `redeemOneTimeToken()` marks the token used before emitting the session token. Any replay fails with HTTP `409` (`OTT_ALREADY_USED`).
- **Untrusted scope attenuation**: `contributor` and `viewer` principals always carry `trust: "untrusted"` and are stripped of `cache:write`, `auth:mint`, `mcp:admin`, `plugin:manage`, and `profile:attach`.
- **Sanitized audit ring buffer**: The last 128 auth events (`mint`, `redeem`, `replay_rejected`, `expired_rejected`, `revoke`) are queryable by trusted maintainers on `GET /auth/audit` with zero secret bytes logged.

## Printing one-time tokens for sandboxes and agents

Start Dub with an immediate single-use bootstrap token:

```sh
dub serve --port 7777 --print-one-time-token --sandbox-id ci-42
```

Or mint additional one-time tokens from a running authenticated server or Smithers gateway:

```sh
DUB_TOKEN=... node scripts/mint-sandbox-auth.mjs --principal agent:reviewer --role agent --ttlSeconds 120
SMITHERS_TOKEN=... node scripts/mint-sandbox-auth.mjs --target smithers --ttlSeconds 120
```

## Root-input-tracing security table

Every privileged operation in Dub and its Smithers Cloud factory traces back to its exact origin input and enforcement boundary:

| Privileged step | Origin input | Boundary check | Failure behavior |
| --- | --- | --- | --- |
| Mint one-time sandbox token (`POST /auth/one-time-tokens`) | HTTP `Authorization` header + JSON body | Requires `trust === "trusted"` and `auth:mint` scope verified via SHA-256 + `timingSafeEqual`, rejecting `trusted` for `contributor` or `viewer` roles | HTTP `401`, `403`, or `400`, audited |
| Redeem one-time token (`POST /auth/exchange`) | JSON body `token` (never argv or query string) | Constant-time SHA-256 lookup, 64 KiB body limit, TTL check, atomic `used = true` before session issue | HTTP `401` (`OTT_INVALID` / `OTT_EXPIRED`), `409` (`OTT_ALREADY_USED`), or `413` |
| Invoke privileged MCP tools (`profile_attach`, `plugin_load`, `plugin_unload`, `plugin_reload`, `quit`) | HTTP `Authorization` + single or batched JSON-RPC `tools/call` | `checkUntrustedMcpGate` inspects both single objects and JSON-RPC batch arrays, blocking `trust === "untrusted"` before incur/Chromium | HTTP `403` with JSON-RPC `-32003` |
| Write to shared Smithers Cloud object store (`https://build.smithers.sh`) | GitHub event + `SMITHERS_CACHE_WRITE_TOKEN` | Exposed strictly on `push` to `main` or maintainer `workflow_dispatch`, never on `pull_request` | Read-only cache fallback on untrusted PRs |
| Modify `protectedPaths` (`.github`, `.smithers`, `.agents`, `chromium/patches`, `native`) | PR diff / Smithers Change | `S.Github.Policy` flags protected paths and restricts `todo` and merge actions to `maintainers: ["roninjin10"]` | Human maintainer approval required |
| Publish npm package or deploy docs (`dangerouslyusebrowser.smithers.sh`) | Verified `main` commit merged by human maintainer | `release.yml` runs full `smthrs ci //...`, `npm test`, `uphill --require-targets`, and tarball rehearsal | Pipeline aborts on any non-zero exit |

## Connecting agents to Smithers Cloud MCP

`.mcp.json` configures `smithers-cloud` at `https://smithers.sh/api/mcp` so every agent working on Dub interacts directly with Smithers Cloud to manage artifacts, TODOs, issues, PRs, stacks of changesets, flows, and wiki pages. Person-only actions (merging, final triage, committing TODOs, secrets) remain host-enforced for human maintainers.

## Related pages

- [[start-here]]
- [[factory-and-trust]]

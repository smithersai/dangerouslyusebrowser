# Contributing to Dub

Dub (`smithersai/dangerouslyusebrowser`) is developed publicly on [Smithers Cloud](https://smithers.sh/smithersai/dangerouslyusebrowser) and mirrored to [GitHub](https://github.com/smithersai/dangerouslyusebrowser). External contributions, bug reports, fuzz cases, and Chromium seam improvements are welcome.

## Quick start

```sh
npm ci
npm run build:native
npm run typecheck
npm run build
npm test
npm run ci
uphill --compact
```

Use Jujutsu (`jj`) for version control (`jj status`, `jj diff`, `jj commit`, `jj bookmark`, `jj git push`).

## Connecting your agent via Smithers Cloud MCP

This repository ships `.mcp.json` pointing to `https://smithers.sh/api/mcp`. Connect your own agent (Claude Code, Codex, Antigravity, Cursor) over MCP to read issues, create artifacts, propose changesets, and inspect flows. Person-only actions (merging, final triage, committing TODOs, secrets) always require a human maintainer.

## Trust model: untrusted runs are encouraged

You do not need maintainer permissions to build, test, fuzz, or audit Dub:
- Non-maintainer and fork pull requests run all unit, fuzz, MCP, and Uphill Lighthouse checks in **untrusted** mode with read-only access to the shared Smithers Cloud object store (`https://build.smithers.sh`).
- Untrusted execution results never write to the shared cache, never receive release credentials, and never skip maintainer review or `protectedPaths` gates (`.github/`, `.smithers/`, `.agents/`, `chromium/patches/`, `native/`, `scripts/`, `package.json`).
- After review, a human maintainer (`roninjin10`) lands approved changes with full contributor credit. Merging to `main` automatically runs trusted verification, updates the shared cache, publishes docs/wiki/audit reports to `dangerouslyusebrowser.smithers.sh`, and triggers releases when `package.json` version advances.

## Quality bar and Lighthouse backpressure

Every change is measured by five Uphill backpressure categories:
1. **Native Bridge & Seam Safety**: C++20 `-Wall -Wextra -Werror`, zero `abort()`/`exit()`, valid Chromium 157 overlay patches, zero private infrastructure leaks.
2. **TypeScript Quality**: Zero explicit `any`, zero `@ts-ignore`/`@ts-expect-error`, zero `console.log` in library modules, concise functions.
3. **MCP Security & Trust**: Loopback default, Host/Origin pinning, SHA-256 + `timingSafeEqual` one-time tokens, untrusted attenuation, protected paths.
4. **Testing & Fuzzing**: Real tests for every behavior change, fuzz coverage on wire/auth/install boundaries, compiled-fork browser proofs for browser claims.
5. **Docs, Wiki & Footprint**: Lean prebuilds, zero broken Markdown links, up-to-date wiki, Mythical History, and `llms.txt`.

Never claim an unbuilt Chromium patch or a bridge-fixture test proves compiled-browser behavior. See [docs/acceptance.md](docs/acceptance.md) and [docs/first-build.md](docs/first-build.md) for the full contract.

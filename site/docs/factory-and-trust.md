# Smithers Cloud factory, object store, and trust model

Dub is built publicly as a Smithers Cloud coding factory at [smithers.sh/smithersai/dangerouslyusebrowser](https://smithers.sh/smithersai/dangerouslyusebrowser), mirroring cleanly to [github.com/smithersai/dangerouslyusebrowser](https://github.com/smithersai/dangerouslyusebrowser).

## Shared Smithers Cloud object store (`.smithers/WORKSPACE.ts`)

Every build and test target declared in `PACKAGE.ts` and `.smithers/PACKAGE.ts` hashes its exact source closure and declared host binaries (`node`, `npm`, `bun`, `c++`, `sh`). Results cache locally in `.smithers/cache` and sync through the shared Smithers Cloud object store at `https://build.smithers.sh` using separated credentials:

- `SMITHERS_CACHE_READ_TOKEN`: Read-only cache lookup (safe to expose to untrusted runs).
- `SMITHERS_CACHE_WRITE_TOKEN`: Cache publication (restricted strictly to trusted maintainer and `main`-branch controlled sandboxes).

## Trusted vs untrusted execution

We actively welcome and encourage non-maintainers to run tests, Uphill audits, and flows on their changes, because most contributors act in good faith. Security holds by construction rather than by blocking contributors:

| Capability | Trusted (Maintainer / Controlled Sandbox) | Untrusted (Non-Maintainer / Fork PR) |
| --- | --- | --- |
| Run unit, fuzz, MCP, and Uphill checks | Allowed | Allowed and encouraged |
| Read from `build.smithers.sh` cache | Allowed | Allowed (read-only) |
| Write to `build.smithers.sh` object store | Allowed | Blocked (no write token) |
| Modify `protectedPaths` (`.github`, `.smithers`, `chromium/patches`, `native`) | Allowed with review | Flagged and gated for maintainer |
| Skip quality gates or merge to `main` | Human maintainer only | Blocked |
| Trigger npm release and docs publish | Automatic on merge to `main` | Blocked |

## Lighthouse-style backpressure (`.agents/uphill/`)

Instead of opaque CI logs, Dub runs Uphill across five scored categories (`bridge-safety`, `typescript-quality`, `mcp-security`, `testing-and-fuzz`, `docs-and-footprint`), rendering a Google Lighthouse-style visual audit report (`site/audit.html` and `.uphill/report.html`) with 0-100 circular gauges, missed targets, baseline diffs, and opportunities ranked by score impact.

## Personalized Factory UI (`.smithers/home.json`)

The Smithers Cloud homepage adapts automatically to who opens the repository:
- **Maintainer (`roninjin10`)**: Opens on the `Today` cockpit (`branch.new` hotkey `b`, live `issues`, live `stack` of changesets, live `runs`, and maintainer flow controls).
- **Contributor**: Opens on the `Contribute` workbench (setup commands, untrusted-to-trusted workflow cards, links to Issues/PRs/Audit/Wiki, and codebase Q&A).
- **Viewer (`everyone`)**: Opens on the open-source front door (Hero with install command, quickstart code, verified stats, capability cards, releases, and live audit links).

## Automatic release and docs publishing

Merging from Smithers Cloud to GitHub `main` automatically runs `.github/workflows/release.yml`, which:
1. Checks whether `package.json` version moved ahead of npm or whether docs, wiki, site, or audit files changed.
2. Runs full incremental CI (`smthrs ci //...`) and Lighthouse backpressure (`uphill --compact`).
3. Rehearses and publishes `dangerouslyusebrowser` to npm + creates a verified GitHub Release when the version advances.
4. Rebuilds and deploys `dangerouslyusebrowser.smithers.sh` (landing page, personalized factory UI, live Lighthouse audit report, public wiki, Mythical History, and `llms.txt`).

## Related pages

- [start-here](https://dangerouslyusebrowser.smithers.sh/docs/start-here.md)
- [cloud-mcp-and-auth](https://dangerouslyusebrowser.smithers.sh/docs/cloud-mcp-and-auth.md)

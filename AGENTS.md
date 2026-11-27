# Dub

Use jj to commit verified chunks, specifications and decisions as work proceeds. Keep the main bookmark current and push main.

Work on main. Dub is a real Chromium fork, with a native N-API bridge and typed incur commands. Do not replace it with Playwright, a stock-CDP server, or a CEF/Electron product. Native seams may use existing Chromium facilities where appropriate, but must be extensible inside the fork.

Keep Chromium pinned in chromium/revision.json; apply the overlay with scripts/chromium.mjs. Upstream source stays outside this repository. Every advertised capability needs a test against the actual compiled Dub browser. Transport fixtures prove the native bridge only, not browser behavior. Never call an unbuilt overlay verified or present a speculative demo as a working feature.

Follow docs/first-build.md for startup/shutdown, selected-profile ownership and bounded native requests. Gate advertised commands on the runtime capability handshake and real-browser evidence. Timeout or disconnect never implies rollback or authorizes an automatic retry.

Use a separate persistent profile by default. Explicit profile paths may select a user's real profile; never copy, extract, or inspect credentials as part of development. Keep the default MCP listener on loopback and require a token for other hosts. Avoid private infrastructure details in committed files.

Run npm run build:native, npm run typecheck, npm test, and the opt-in real-browser suite with DUB_BROWSER set before claiming release readiness. Track unfinished work in the private launch issue recorded in .local/launch-issue-url (do not publish private launch context).

## Smithers Cloud Coding Factory

Dub is built publicly on Smithers Cloud (`https://smithers.sh/smithersai/dangerouslyusebrowser`), mirrored to GitHub (`smithersai/dangerouslyusebrowser`), and documented at `https://dangerouslyusebrowser.smithers.sh`.

- **Smithers Cloud MCP:** Agents developing Dub should connect to `https://smithers.sh/api/mcp` (configured in `.mcp.json`) to create and manage artifacts, TODOs, issues, PRs, stacks of changesets, flows, and wiki updates. Person-only actions (merging, final triage, committing TODOs, secrets) remain restricted to human maintainers (`roninjin10`).
- **Incremental build graph & shared object store:** Run `npm run ci` (`smthrs ci //...`) to execute incremental targets backed by the shared Smithers Cloud object store (`https://build.smithers.sh`). Untrusted/non-maintainer runs are encouraged and receive read-only cache access at most (`SMITHERS_CACHE_READ_TOKEN`), never write access (`SMITHERS_CACHE_WRITE_TOKEN`) or gate bypasses.
- **One-time sandbox auth:** Use `dub serve --print-one-time-token`, `dub auth mint`, or `scripts/mint-sandbox-auth.mjs` to issue short-lived single-use bootstrap tokens for sandboxes and BYO agents. Never pass secrets on argv or commit long-lived credentials.
- **Lighthouse backpressure & knowledge:** Run `uphill check && uphill --compact --require-targets` and `node scripts/build-site.mjs` when changing code, flows, wiki pages (`.smithers/wiki/`), or docs so `site/audit.html`, `site/wiki.html`, `site/history.html`, and `site/llms.txt` stay fresh and verified.

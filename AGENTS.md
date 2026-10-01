# Dub

Work on main. Dub is a real Chromium fork, with a native N-API bridge and typed incur commands. Do not replace it with Playwright, a stock-CDP server, or a CEF/Electron product. Native seams may use existing Chromium facilities where appropriate, but must be extensible inside the fork.

Keep Chromium pinned in chromium/revision.json; apply the overlay with scripts/chromium.mjs. Upstream source stays outside this repository. Every advertised capability needs a test against the actual compiled Dub browser. Transport fixtures prove the native bridge only, not browser behavior. Never call an unbuilt overlay verified or present a speculative demo as a working feature.

Use a separate persistent profile by default. Explicit profile paths may select a user's real profile; never copy, extract, or inspect credentials as part of development. Keep the default MCP listener on loopback and require a token for other hosts. Avoid private infrastructure details in committed files.

Run npm run build:native, npm run typecheck, npm test, and the opt-in real-browser suite with DUB_BROWSER set before claiming release readiness. Track unfinished work in the private launch issue recorded in .local/launch-issue-url (do not publish private launch context).

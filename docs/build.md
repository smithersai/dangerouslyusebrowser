# Chromium build plan

This is the planned builder procedure. The repository contains a pinned source manifest and draft overlay, but the overlay is not yet integrated into GN or compiled. Build orchestration and binary distribution remain open in [plue#777](https://github.com/smithersai/plue/issues/777). Do not run an imagined `scripts/chromium.mjs` yet; that script is a named deliverable, not an existing command.

## Builder target

First supported browser artifact: Linux x86-64 on Ubuntu 22.04/24.04, using Chromium's supported Clang/libc++ toolchain and checked-out depot_tools. Choose 128 GB RAM and at least 500 GB usable NVMe for repeated builds, dependencies, output, and room for failed-build diagnostics. Provider selection, quotes, access and operational details stay private.

The pinned upstream [Linux instructions](https://chromium.googlesource.com/chromium/src/+/0e331aaf43bf5e1ffe16e65140de2d925c18f0a2/docs/linux/build_instructions.md) require at least 100 GB free. This is a minimum, not a comfortable capacity plan. Source sync and compilation time must be measured on the purchased host; there is no validated build-time estimate yet.

macOS native binding compilation has been verified locally. A macOS browser build, packaging, signing and clean-install receipt are separate work; Linux compilation is not evidence of a macOS browser artifact.

## Reproducible build sequence

1. Record host architecture, distro, CPU/RAM, disk, toolchain and depot_tools revision in a receipt. Reserve an unprivileged build user and a persistent source/output directory. Preserve Chromium's sandbox.
2. Use depot_tools to sync Chromium plus DEPS at `chromium/revision.json`. Check the resolved revision and V8 DEPS pin. Store upstream source outside the Dub product checkout.
3. Install upstream build dependencies, then run gclient hooks. Record downloaded toolchain revisions and resulting GN/Ninja versions.
4. Implement `scripts/chromium.mjs` with fetch/apply/check/build/package actions. Patch application must validate the exact base revision, refuse unrelated dirty source, be idempotent, and record hashes of the overlay and resulting source diff. Never silently apply approximate hunks to another revision.
5. Follow the [first-build integration plan](first-build.md) for the exact GN owners, Chrome startup/shutdown hooks, session ownership and request deadlines. Build the smallest browser slice before adding the network/time changes. Stubbed methods must stay absent from the runtime capability list.
6. Initial GN development profile: `is_debug=false`, `is_component_build=true`, `symbol_level=0`, `blink_symbol_level=0`, `v8_symbol_level=0`, `is_official_build=false`, `use_remoteexec=false`. Verify these against the pinned GN graph. Build the `chrome` target and preserve the complete log and exit status.
7. Launch the fork with a temporary dedicated profile and local private socket. Run real N-API and MCP browser tests. Browser identity, revision and native method inventory must be in the receipt. Do not substitute a downloaded Chrome/CEF binary.
8. Once development gates pass, create a release build profile with redistributable runtime files, Chromium license/third-party notices and required helper/sandbox binaries. Package every component-build dependency if using that profile; a lone `chrome` executable is not a usable artifact.
9. Generate SHA-256 checksums, publish an explicit prerelease only after the complete artifact is reviewable, and install it in a fresh environment. Verify `dub serve`, all demos, profile persistence and shutdown from the installed package.

## Build operating model

One authoritative builder compiles the source tree. Seams are small reviewable overlays in the product repo, not multiple copies of Chromium per agent. Use jj commits on main and sync exact revisions to the builder. Record the Dub commit, Chromium pin, patch manifest, GN args and test commands together. Stop a failed build only after inspecting its actual process handle and error; a lost SSH observation is not proof it ended.

## Evidence boundaries

- Native addon build: passed on the local Mac.
- Unit/protocol/MCP fixture tests: 11 passed at the initial SDK checkpoint.
- Chromium overlay application: not verified.
- GN generation and Chromium compilation: not run.
- Real-browser acceptance suite and demo: not implemented/run.
- Installable browser archive/npm release: not produced.

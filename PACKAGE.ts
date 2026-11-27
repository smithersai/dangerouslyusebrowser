import { Smithers as S } from "@smthrs/targets"

const node = S.Host.bin("node")
const npm = S.Host.bin("npm")
const cxx = S.Host.bin("c++")
const sh = S.Host.bin("sh")

// Tight source closures so unrelated edits never invalidate cached build/test targets.
const manifests = S.Filegroup({
  cwd: "//",
  srcs: [
    S.file("//package.json"),
    S.file("//package-lock.json"),
    S.file("//tsconfig.json")
  ]
})

const nativeSources = S.Filegroup({
  cwd: "//",
  srcs: [
    S.glob("//native/**"),
    S.file("//scripts/build-native.mjs")
  ]
})

const tsSources = S.Filegroup({
  cwd: "//",
  srcs: [
    manifests,
    S.glob("//src/**"),
    S.glob("//bin/**")
  ]
})

const chromiumOverlay = S.Filegroup({
  cwd: "//",
  srcs: [
    S.file("//chromium/revision.json"),
    S.glob("//chromium/overlay/**"),
    S.glob("//chromium/patches/**"),
    S.file("//scripts/chromium.mjs"),
    S.file("//scripts/verify-overlay.mjs")
  ]
})

const nativeBuild = S.Shell.Build({
  summary: "Compile the C++20 N-API bridge addon (build/Release/dub.node)",
  bin: node,
  tools: [cxx],
  args: ["scripts/build-native.mjs"],
  data: [nativeSources],
  outDirs: ["build/Release"],
  sandbox: "none",
  timeout: "5m"
})

const typecheck = S.Shell.Test({
  summary: "Typecheck TypeScript sources with tsc --noEmit",
  bin: npm,
  tools: [node],
  args: ["run", "typecheck"],
  data: [tsSources],
  sandbox: "none",
  timeout: "5m"
})

const tsBuild = S.Shell.Build({
  summary: "Emit compiled JavaScript and declaration files into dist/",
  bin: npm,
  tools: [node],
  args: ["run", "build"],
  data: [tsSources],
  outDirs: ["dist"],
  sandbox: "none",
  timeout: "5m"
})

const testNative = S.Shell.Test({
  summary: "Run compiled N-API framing, deadline, concurrency, and push-stream tests",
  bin: node,
  args: ["--test", "tests/native.test.mjs"],
  data: [nativeBuild, tsBuild, S.file("//tests/native.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const testMcp = S.Shell.Test({
  summary: "Run incur MCP client, HTTP security boundary, capability handshake, and auth tests",
  bin: node,
  args: ["--test", "tests/mcp.test.mjs"],
  data: [nativeBuild, tsBuild, S.file("//tests/mcp.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const testFuzz = S.Shell.Test({
  summary: "Run N-API framing, installer SHA-256, duration, and HTTP boundary fuzz tests",
  bin: node,
  args: ["--test", "tests/fuzz.test.mjs"],
  data: [nativeBuild, tsBuild, S.file("//tests/fuzz.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const testPlugins = S.Shell.Test({
  summary: "Run Smithers QuickJS code mode, Jev, BYO agent, reactive trigger, and plugin tests",
  bin: node,
  args: ["--test", "tests/plugins-smithers.test.mjs"],
  data: [nativeBuild, tsBuild, S.file("//tests/plugins-smithers.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const testAuth = S.Shell.Test({
  summary: "Run cloud MCP one-time sandbox auth, replay rejection, and untrusted attenuation tests",
  bin: node,
  args: ["--test", "tests/auth.test.mjs"],
  data: [tsBuild, S.file("//tests/auth.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const testFactory = S.Shell.Test({
  summary: "Verify Smithers Cloud home schema, factory flows, CI trust isolation, wiki, and audit UI",
  bin: node,
  args: ["--test", "tests/factory.test.mjs"],
  data: [
    S.file("//tests/factory.test.mjs"),
    S.file("//.mcp.json"),
    S.file("//.smithers/WORKSPACE.ts"),
    S.file("//.smithers/factory.json"),
    S.file("//.smithers/home.json"),
    S.file("//.smithers/coding-project.json"),
    S.glob("//.smithers/wiki/**"),
    S.glob("//.github/workflows/**"),
    S.file("//site/llms.txt"),
    S.file("//site/audit.html"),
    S.file("//site/history.html")
  ],
  sandbox: "none",
  timeout: "5m"
})

const testCliScripts = S.Shell.Test({
  summary: "Run CLI one-time auth mint/exchange, sandbox script, and Home/site contract tests",
  bin: node,
  args: ["--test", "tests/cli-and-scripts.test.mjs"],
  data: [
    tsBuild,
    S.glob("//bin/**"),
    S.file("//tests/cli-and-scripts.test.mjs"),
    S.file("//scripts/mint-sandbox-auth.mjs"),
    S.file("//scripts/verify-overlay.mjs"),
    S.file("//scripts/verify-factory.mjs"),
    S.file("//scripts/verify-home.mjs"),
    S.file("//.smithers/factory.json"),
    S.file("//.smithers/home.json"),
    S.file("//site/index.html"),
    S.file("//site/audit-summary.json")
  ],
  sandbox: "none",
  timeout: "5m"
})

const testLaunch = S.Shell.Test({
  summary: "Run launch socket guards, attachProfile ownership states, and Browser handshake tests",
  bin: node,
  args: ["--test", "tests/launch-and-browser.test.mjs"],
  data: [nativeBuild, tsBuild, S.file("//tests/launch-and-browser.test.mjs")],
  sandbox: "none",
  timeout: "5m"
})

const overlayCheck = S.Shell.Test({
  summary: "Verify pinned Chromium 157 revision, unified patches, and leak-free overlay files",
  bin: node,
  args: ["scripts/verify-overlay.mjs"],
  data: [chromiumOverlay],
  sandbox: "none",
  timeout: "2m"
})

const cliSmoke = S.Shell.Test({
  summary: "Verify dub CLI entry point renders help without launching Chromium",
  bin: sh,
  tools: [node],
  args: ["-eu", "-c", "node bin/dub.mjs --help >/dev/null"],
  data: [nativeBuild, tsBuild, S.glob("//bin/**")],
  sandbox: "none",
  timeout: "2m"
})

export const Package = S.Package({
  targets: {
    "manifests": manifests,
    "native-sources": nativeSources,
    "ts-sources": tsSources,
    "chromium-overlay": chromiumOverlay,
    "native-build": nativeBuild,
    "typecheck": typecheck,
    "ts-build": tsBuild,
    "test-native": testNative,
    "test-mcp": testMcp,
    "test-fuzz": testFuzz,
    "test-plugins": testPlugins,
    "test-auth": testAuth,
    "test-factory": testFactory,
    "test-cli-scripts": testCliScripts,
    "test-launch": testLaunch,
    "overlay-check": overlayCheck,
    "cli-smoke": cliSmoke
  }
})

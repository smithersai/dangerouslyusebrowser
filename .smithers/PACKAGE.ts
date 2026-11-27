import { Smithers as S } from "@smthrs/targets"

const node = S.Host.bin("node")

const factorySources = S.Filegroup({
  srcs: [
    S.glob("**", {
      exclude: [
        "cache/**",
        "reports/**",
        "node_modules/**",
        "state/**",
        "tmp/**",
        "pg/**",
        "*.db*"
      ]
    })
  ]
})

const factoryCheck = S.Shell.Test({
  summary: "Verify .smithers/factory.json flows, event triggers, maintainers, and protectedPaths",
  bin: node,
  args: ["scripts/verify-factory.mjs"],
  data: [factorySources, S.file("//scripts/verify-factory.mjs")],
  sandbox: "none",
  timeout: "2m"
})

const homeCheck = S.Shell.Test({
  summary: "Validate .smithers/home.json against @smthrs/views Home schema and audience rules",
  bin: node,
  args: ["scripts/verify-home.mjs"],
  data: [S.file("//.smithers/home.json"), S.file("//scripts/verify-home.mjs")],
  sandbox: "none",
  timeout: "2m"
})

export const Package = S.Package({
  targets: {
    "factory-sources": factorySources,
    "factory-check": factoryCheck,
    "home-check": homeCheck
  }
})

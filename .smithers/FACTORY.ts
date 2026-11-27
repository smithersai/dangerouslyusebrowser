/**
 * The Smithers Cloud coding factory for smithersai/dangerouslyusebrowser (Dub):
 * https://smithers.sh/smithersai/dangerouslyusebrowser
 *
 * Projected into .smithers/factory.json by `npm run factory:write`
 * (//.smithers:factory-write) and drift-checked by `npm run factory:check`
 * (//.smithers:factory-check).
 *
 * The personalized repository home for Maintainers, Contributors, and Viewers
 * lives in .smithers/home.json and is schema-checked against `@smthrs/views`
 * by //.smithers:home-check.
 */
import { Smithers as S } from "@smthrs/targets"

export const uphill = S.Flow({
  flow: "uphill",
  featured: true,
  summary: "Run Lighthouse-style backpressure metrics across bridge safety, TypeScript, MCP security, fuzzing, and docs."
})

export const review = S.Flow({
  flow: "checks/review",
  featured: true,
  summary: "Multi-lens review covering Chromium 157 seams, C++20 N-API safety, MCP one-time auth, and QuickJS plugins."
})

export const prTriage = S.Flow({
  flow: "pr-triage",
  featured: true,
  summary: "Triage pull requests as untrusted input without approving, merging, or writing to the shared cache."
})

export const issueRepro = S.Flow({
  flow: "issue/repro",
  featured: true,
  summary: "Reproduce a Dub bug with the smallest native, MCP, or browser fixture before planning a fix."
})

export const issuePoc = S.Flow({
  flow: "issue/poc",
  featured: true,
  summary: "Build a failing-test-first proof of concept for a maintainer-accepted TODO issue."
})

export const sandboxAuth = S.Flow({
  flow: "sandbox-auth",
  featured: true,
  summary: "Mint a short-lived single-use authentication token for a controlled sandbox or BYO agent."
})

export const wiki = S.Flow({
  flow: "wiki",
  featured: false,
  summary: "Verify and refresh Dub's Obsidian-compatible source-cited wiki and site/llms.txt index."
})

export const mythicalHistory = S.Flow({
  flow: "mythical-history",
  featured: false,
  summary: "Regenerate Dub's Mythical History chronicle from verified jj commits and launch evidence."
})

export const release = S.Flow({
  flow: "release",
  featured: false,
  summary: "Check, rehearse, gate on Lighthouse backpressure, and publish a Dub release after maintainer approval."
})

export const docsPublish = S.Flow({
  flow: "docs-publish",
  featured: false,
  summary: "Rebuild and publish docs, public wiki, Mythical History, Lighthouse audit report, and llms.txt."
})

export const factory = S.Factory({
  summary: "Dub Chromium 157 fork: incremental N-API CI, Lighthouse backpressure, one-time sandbox auth, and public wiki.",
  flows: [
    uphill,
    review,
    prTriage,
    issueRepro,
    issuePoc,
    sandboxAuth,
    wiki,
    mythicalHistory,
    release,
    docsPublish
  ],
  on: {
    "issue.labeled:todo": {
      flow: "issue/poc",
      description: "Build a failing test and PoC for every maintainer-accepted TODO"
    },
    "change.opened": {
      flow: "checks/review",
      description: "Review every Change across Dub's Chromium, N-API, MCP security, and runtime lenses"
    },
    "change.updated": {
      flow: "checks/review",
      description: "Re-review every updated Change"
    },
    "schedule:0 14 * * 1": {
      flow: "uphill",
      description: "Weekly Monday Lighthouse backpressure audit across all five Dub quality categories"
    }
  },
  github: S.Github.Policy({
    mirror: "pull",
    issues: "two-way",
    changes: "send-upstream",
    maintainers: ["roninjin10"],
    protectedPaths: [
      ".github",
      ".smithers",
      ".agents",
      "PACKAGE.ts",
      "AGENTS.md",
      "package.json",
      "package-lock.json",
      "chromium/revision.json",
      "chromium/patches",
      "native",
      "scripts"
    ]
  })
})

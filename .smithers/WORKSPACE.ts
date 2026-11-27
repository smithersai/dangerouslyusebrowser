import { Smithers as S } from "@smthrs/targets"

// Smithers incremental build graph for Dub (smithersai/dangerouslyusebrowser).
//
// Every target's cache key is the digest of the exact source files, upstream
// targets, and host binaries it declares:
//   - Editing docs, wiki, or site assets never invalidates C++ N-API or TS tests.
//   - Editing Chromium overlay patches never invalidates the Node N-API bridge.
//   - Local runs cache in `.smithers/cache` and share artifacts through the
//     Smithers Cloud object store (`https://build.smithers.sh`).
//
// Trust boundary:
//   - Maintainers and controlled Smithers Cloud / main-branch sandboxes carry
//     both `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN`.
//   - Non-maintainer / untrusted runs receive read-only cache access at most
//     and can never poison the shared object store or skip release gates.
export const Workspace = S.Workspace("dub", {
  repository: "smithersai/dangerouslyusebrowser",
  cache: S.Cache({
    directory: ".smithers/cache",
    hostDirectories: ["build", "dist"],
    remote: S.RemoteCache.make({
      endpoint: "https://build.smithers.sh",
      read: S.Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: S.Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
  }),
  host: S.Host({
    bins: ["node", "npm", "bun", "c++", "sh"]
  }),
  discovery: {
    prune: [
      "node_modules",
      "dist",
      "dist-release",
      "build",
      ".local",
      ".flows",
      ".uphill",
      ".wrangler",
      ".smithers/cache",
      ".smithers/reports",
      ".smithers/node_modules",
      ".smithers/state",
      ".smithers/tmp",
      ".smithers/pg",
      "artifacts"
    ]
  }
})

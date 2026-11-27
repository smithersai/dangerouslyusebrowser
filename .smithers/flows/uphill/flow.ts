/**
 * `uphill`: Lighthouse-style continuous backpressure metrics for Dub.
 *
 * Runs `uphill check`, `uphill --compact`, and generates the interactive
 * Lighthouse audit report (`site/audit.html` and `.uphill/report.json`)
 * inside a durable Smithers CI job.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const implementationVersion = "uphill/v1"

const uphillJob = CiJob.make("uphill", {
  steps: [
    {
      name: "install-uphill",
      run: "command -v uphill >/dev/null 2>&1 || curl -fsSL https://wevm.sh/uphill | sh"
    },
    {
      name: "uphill-check",
      run: "PATH=\"$HOME/.uphill/bin:$HOME/.bun/bin:$PATH\" uphill check"
    },
    {
      name: "uphill-compact",
      run: "PATH=\"$HOME/.uphill/bin:$HOME/.bun/bin:$PATH\" uphill --compact"
    },
    {
      name: "build-audit-report",
      run: "node scripts/build-audit-report.mjs"
    }
  ]
})

export default Flow.make("uphill", {
  description: "Score Dub bridge safety, TypeScript quality, MCP security, fuzzing, and docs with Uphill Lighthouse backpressure.",
  capabilities: ["sandbox:job"],
  effects: {
    reads: ["**"],
    writes: [".uphill/**", "site/audit.html"],
    mode: "expected",
    onConflict: "serialize",
    tier: "reversible"
  },
  modelInvocable: true,
  payload: Schema.Struct({
    run: CiJob.Target.fields.run,
    repo: CiJob.Target.fields.repo,
    sha: CiJob.Target.fields.sha,
    ref: CiJob.Target.fields.ref
  }),
  success: CiJob.Result,
  body: Node.capture(
    { implementationVersion },
    (target: CiJob.Target) => uphillJob.call(target)
  )
})

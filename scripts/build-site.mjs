#!/usr/bin/env node
/**
 * Rebuild all generated Dub public surfaces in dependency order:
 *   1. Mythical History (.smithers/wiki/mythical-history.md + site/history.html)
 *   2. Knowledge Graph (site/docs/*.md + site/llms.txt + site/llms-full.txt + site/wiki.html)
 *   3. Uphill Lighthouse Backpressure Audit (.uphill/report.json + site/audit.html)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uphillBin = existsSync(`${process.env.HOME}/.uphill/bin/uphill`)
  ? `${process.env.HOME}/.uphill/bin/uphill`
  : 'uphill';

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run(process.execPath, ['scripts/build-mythical-history.mjs']);
run(process.execPath, ['scripts/build-knowledge.mjs']);
// Generate initial audit.html so uphill's factory-knowledge check sees all files, then refresh with exact scores.
run(uphillBin, ['--compact']);
run(process.execPath, ['scripts/build-audit-report.mjs']);
run(uphillBin, ['--compact']);
run(process.execPath, ['scripts/build-audit-report.mjs']);
run(process.execPath, ['scripts/build-knowledge.mjs']);

#!/usr/bin/env node
/**
 * Mint a short-lived, single-use authentication token for a sandbox or BYO agent
 * against either a running Dub cloud MCP server (`DUB_MCP_URL`) or a Smithers
 * gateway (`SMITHERS_TOKEN` via `smthrs token`).
 *
 * Security invariants:
 * - Never passes tokens on child process argv.
 * - Prints the one-time token ONCE to stdout (or JSON with --json) with explicit
 *   principal, role, trust level, scopes, and expiry.
 * - Untrusted roles (contributor, viewer) are strictly attenuated to read-only cache
 *   and non-privileged scopes.
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'dub' },
    url: { type: 'string', default: process.env.DUB_MCP_URL || 'http://127.0.0.1:7777' },
    principal: { type: 'string', default: 'sandbox:ephemeral' },
    role: { type: 'string', default: 'sandbox' },
    trust: { type: 'string' },
    sandboxId: { type: 'string' },
    ttlSeconds: { type: 'string', default: '120' },
    json: { type: 'boolean', default: false },
  },
});

if (values.target === 'smithers') {
  const res = spawnSync(
    './node_modules/.bin/smthrs',
    ['token', 'mint', '--ttl', `${values.ttlSeconds}s`, '--format', 'json'],
    { encoding: 'utf8', env: process.env }
  );
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout || 'Failed to mint Smithers gateway token (ensure SMITHERS_TOKEN is set)');
    process.exit(res.status ?? 1);
  }
  process.stdout.write(res.stdout);
  process.exit(0);
}

const masterToken = process.env.DUB_TOKEN;
if (!masterToken) {
  console.error('DUB_TOKEN environment variable is required to mint a Dub one-time sandbox token.');
  process.exit(1);
}

const endpoint = `${values.url.replace(/\/$/, '')}/auth/one-time-tokens`;
const ttlMs = Number(values.ttlSeconds) * 1000;
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${masterToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    principal: values.principal,
    role: values.role,
    ...(values.trust ? { trust: values.trust } : {}),
    ...(values.sandboxId ? { sandboxId: values.sandboxId } : {}),
    ttlMs,
  }),
});

if (!response.ok) {
  console.error(`Failed to mint one-time token (HTTP ${response.status}): ${await response.text()}`);
  process.exit(1);
}

const minted = await response.json();
if (values.json) {
  process.stdout.write(`${JSON.stringify(minted, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `One-Time Auth Token (single use, expires ${minted.expiresAt}):`,
      `  token:     ${minted.oneTimeToken}`,
      `  tokenId:   ${minted.tokenId}`,
      `  principal: ${minted.principal} (${minted.role}, trust=${minted.trust})`,
      `  scopes:    ${minted.scopes.join(', ')}`,
      `  exchange:  POST ${values.url.replace(/\/$/, '')}/auth/exchange`,
    ].join('\n') + '\n'
  );
}

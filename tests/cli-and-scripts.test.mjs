import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Home } from '@smthrs/views';
import { listen } from '../dist/index.js';

const execFile = promisify(execFileCb);
const root = fileURLToPath(new URL('..', import.meta.url));

test('dub CLI auth mint and exchange subcommands redeem one-time sandbox tokens end-to-end', async t => {
  const masterToken = 'dub-cli-auth-master-token-0123456789';
  const server = await listen(async req => Response.json({ ok: true, trust: req.headers.get('x-dub-trust') }), {
    port: 0,
    token: masterToken,
  });
  t.after(() => server.close());

  const mintRes = await execFile(
    process.execPath,
    [
      'bin/dub.mjs',
      'auth',
      'mint',
      '--url',
      server.url,
      '--principal',
      'sandbox:cli-test',
      '--role',
      'sandbox',
      '--sandbox-id',
      'sbx-cli',
      '--format',
      'json',
    ],
    { cwd: root, env: { ...process.env, DUB_TOKEN: masterToken } }
  );
  const minted = JSON.parse(mintRes.stdout);
  assert.match(minted.oneTimeToken, /^dub_ott_/);
  assert.equal(minted.trust, 'trusted');
  assert.equal(minted.sandboxId, 'sbx-cli');

  const exchRes = await execFile(
    process.execPath,
    ['bin/dub.mjs', 'auth', 'exchange', '--url', server.url, '--format', 'json'],
    { cwd: root, env: { ...process.env, DUB_ONE_TIME_TOKEN: minted.oneTimeToken } }
  );
  const exchanged = JSON.parse(exchRes.stdout);
  assert.match(exchanged.sessionToken, /^dub_ses_/);
  assert.equal(exchanged.principal.principal, 'sandbox:cli-test');

  // Replaying the same one-time token through CLI must fail cleanly
  await assert.rejects(
    execFile(
      process.execPath,
      ['bin/dub.mjs', 'auth', 'exchange', '--url', server.url, '--format', 'json'],
      { cwd: root, env: { ...process.env, DUB_ONE_TIME_TOKEN: minted.oneTimeToken } }
    )
  );

  // Authenticated call using the exchanged session token succeeds
  const check = await fetch(`${server.url}/mcp`, {
    headers: { authorization: `Bearer ${exchanged.sessionToken}` },
  });
  assert.equal(check.status, 200);
  const body = await check.json();
  assert.equal(body.trust, 'trusted');
});

test('scripts/mint-sandbox-auth.mjs prints single-use tokens in human and JSON modes', async t => {
  const masterToken = 'dub-script-master-token-0123456789ab';
  const server = await listen(async () => Response.json({ ok: true }), {
    port: 0,
    token: masterToken,
  });
  t.after(() => server.close());

  const jsonRun = await execFile(
    process.execPath,
    [
      'scripts/mint-sandbox-auth.mjs',
      '--url',
      server.url,
      '--principal',
      'contributor:demo',
      '--role',
      'contributor',
      '--json',
    ],
    { cwd: root, env: { ...process.env, DUB_TOKEN: masterToken } }
  );
  const minted = JSON.parse(jsonRun.stdout);
  assert.equal(minted.trust, 'untrusted');
  assert.equal(minted.scopes.includes('cache:write'), false);

  const humanRun = await execFile(
    process.execPath,
    ['scripts/mint-sandbox-auth.mjs', '--url', server.url, '--principal', 'agent:qa', '--role', 'agent'],
    { cwd: root, env: { ...process.env, DUB_TOKEN: masterToken } }
  );
  assert.match(humanRun.stdout, /One-Time Auth Token/);
  assert.match(humanRun.stdout, /dub_ott_/);
  assert.match(humanRun.stdout, /\/auth\/exchange/);
});

test('factory verification scripts succeed and emit structured JSON receipts', async () => {
  for (const script of ['scripts/verify-overlay.mjs', 'scripts/verify-factory.mjs', 'scripts/verify-home.mjs']) {
    const res = await execFile(process.execPath, [script], { cwd: root });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true, `${script} did not report ok:true`);
  }
});

test('Home.read rejects raw HTML injection and respects audience boundaries', () => {
  const evilHome = JSON.stringify({
    sections: [{ audience: 'everyone', blocks: [{ type: 'text', text: '<script>alert(1)</script>' }] }],
  });
  const bad = Home.read(evilHome);
  assert.equal(bad._tag, 'Invalid');

  assert.equal(Home.sees('everyone', 'maintainer'), false);
  assert.equal(Home.sees('everyone', 'contributor'), false);
  assert.equal(Home.sees('contributor', 'maintainer'), false);
  assert.equal(Home.sees('contributor', 'contributor'), true);
  assert.equal(Home.sees('maintainer', 'maintainer'), true);
  assert.equal(Home.widen('everyone', 'role'), 'everyone');
  assert.equal(Home.widen('everyone', 'anyone'), 'contributor');
});

test('site/audit-summary.json and site/index.html stay aligned with live Uphill report', () => {
  const summary = JSON.parse(readFileSync(resolve(root, 'site/audit-summary.json'), 'utf8'));
  assert.equal(summary.categories.length, 5);
  assert.ok(summary.compositeScore >= 90, `Expected compositeScore >= 90, got ${summary.compositeScore}`);

  const indexHtml = readFileSync(resolve(root, 'site/index.html'), 'utf8');
  assert.match(indexHtml, /data-persona="viewer"/);
  assert.match(indexHtml, /data-persona="contributor"/);
  assert.match(indexHtml, /data-persona="maintainer"/);
  assert.match(indexHtml, /audit-summary\.json/);
  assert.equal(indexHtml.includes('&mdash;'), false, 'Public site must not contain em dashes');
});

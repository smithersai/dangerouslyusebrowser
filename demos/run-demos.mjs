#!/usr/bin/env node
/**
 * Reproducible launch demos (DEMO-01, DEMO-02, DEMO-03) against the real compiled Dub Chromium fork.
 *
 * Usage:
 *   DUB_BROWSER=/path/to/chrome node demos/run-demos.mjs [--out-dir docs/evidence/2026-11-23]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCommands, launch, listen } from '../dist/index.js';

const DUB_BROWSER = process.env.DUB_BROWSER;
if (!DUB_BROWSER) {
  console.error('Error: set DUB_BROWSER=/path/to/dub-chrome before running demos.');
  process.exit(1);
}

let outDir = resolve('docs/evidence/2026-11-23');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out-dir') outDir = resolve(process.argv[++i]);
}
const shotsDir = join(outDir, 'screenshots');
await mkdir(shotsDir, { recursive: true });

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function saveShot(browser, tabId, filename) {
  const shot = await browser.screenshot(tabId);
  const buf = Buffer.from(shot.data, 'base64');
  // Validate PNG signature
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename} must be a valid PNG`);
  const path = join(shotsDir, filename);
  await writeFile(path, buf);
  return { filename, bytes: buf.length, sha256: sha256(buf) };
}

async function waitLoaded(browser, tabId, expectedTitle) {
  for (let i = 0; i < 60; i++) {
    const { tabs } = await browser.tabs();
    const tab = tabs.find(t => t.id === tabId);
    if (tab && !tab.loading && (!expectedTitle || tab.title === expectedTitle)) return tab;
    await delay(100);
  }
  throw new Error(`Timed out waiting for tab ${tabId}`);
}

async function withDubSession(profileDir, fn) {
  const work = await mkdtemp(join(tmpdir(), 'dub-demo-'));
  const socket = join(work, 'dub.sock');
  const session = await launch({
    browser: DUB_BROWSER,
    profile: profileDir,
    socket,
    headless: process.env.DUB_HEADLESS !== '0',
    timeoutMs: 15_000,
  });
  const cli = createCommands(session.browser, {
    methods: session.info.methods,
    tools: session.info.tools,
  });
  const http = await listen(cli.fetch, {
    host: '127.0.0.1',
    port: 0,
    health: () => session.health(),
  });
  const client = new Client({ name: 'dub-demo-runner', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`));
  await client.connect(transport);
  try {
    return await fn({ session, browser: session.browser, client, work });
  } finally {
    await transport.close().catch(() => {});
    await http.close().catch(() => {});
    await session.close().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDemo01() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/user') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: 'alice', role: 'viewer' }));
      return;
    }
    if (url.pathname === '/static/app.123.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end('window.APP_CONFIG = {retries:0};');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Demo 01 Network</title>
<style>body{font-family:system-ui,sans-serif;padding:24px;background:#0f172a;color:#f8fafc}
.card{background:#1e293b;border-radius:12px;padding:20px;max-width:520px}
.badge{display:inline-block;padding:4px 10px;border-radius:6px;background:#16a34a;color:#fff;font-weight:700}</style>
</head>
<body>
<div class="card">
  <h1>Dub Demo 01 — Network Rewrite &amp; Patch</h1>
  <p>User role: <span id="role" class="badge">loading...</span></p>
  <p>JS bundle retries: <strong id="retries">loading...</strong></p>
</div>
<script src="/static/app.123.js"></script>
<script>
  document.getElementById('retries').textContent = String(window.APP_CONFIG.retries);
  fetch('/v1/user').then(r => r.json()).then(d => {
    window.__user = d;
    document.getElementById('role').textContent = d.role;
  });
</script>
</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-demo1-prof-'));

  try {
    return await withDubSession(profileDir, async ({ browser, client, work }) => {
      const fixtureFile = join(work, 'admin-user.json');
      await writeFile(fixtureFile, JSON.stringify({ user: 'alice', role: 'admin', plan: 'enterprise' }));

      const rewriteRes = await client.callTool({
        name: 'net_rewrite',
        arguments: { match: `${baseUrl}/v1/user`, status: 200, body: fixtureFile, contentType: 'application/json' },
      });
      assert.notEqual(rewriteRes.isError, true, JSON.stringify(rewriteRes));

      const patchRes = await client.callTool({
        name: 'net_patch',
        arguments: { match: '*/static/app.*.js', replace: 'retries:0', with: 'retries:3' },
      });
      assert.notEqual(patchRes.isError, true, JSON.stringify(patchRes));

      const tab = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab.id, 'Demo 01 Network');
      await delay(200);

      const state = await browser.evaluate(
        tab.id,
        `({ role: document.getElementById('role').textContent, retries: window.APP_CONFIG.retries })`
      );
      assert.equal(state.role, 'admin', 'API response must be rewritten to admin');
      assert.equal(state.retries, 3, 'Live JS bundle must be patched from retries:0 to retries:3');

      const logRes = await client.callTool({
        name: 'net_log',
        arguments: { match: baseUrl, follow: true, limit: 10, timeoutMs: 800 },
      });
      assert.notEqual(logRes.isError, true, JSON.stringify(logRes));
      const logData = JSON.parse(logRes.content[0].text);
      assert.ok(logData.entries.length >= 2, 'Expected rewritten/patched requests in net log');

      const shot = await saveShot(browser, tab.id, 'demo-01-network-rewrite.png');
      return {
        id: 'DEMO-01',
        passed: true,
        observedState: state,
        logEntries: logData.entries.length,
        screenshots: [shot],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDemo02() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Demo 02 Clock</title>
<style>
  body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:#ffffff;color:#0f172a}
  #banner{padding:16px 20px;border-radius:10px;font-size:22px;font-weight:700;background:#16a34a;color:#fff;margin-bottom:16px}
  #banner.expired{background:#dc2626}
  #track{position:relative;height:100px;background:#f1f5f9;border-radius:10px;overflow:hidden}
  #box{position:absolute;left:20px;top:10px;width:80px;height:80px;border-radius:8px;background:#2563eb;animation:slide 1s linear forwards}
  @keyframes slide{from{left:20px}to{left:620px}}
</style></head>
<body>
  <div id="banner">TRIAL ACTIVE — 2026-01-01</div>
  <div id="track"><div id="box"></div></div>
  <script>
    window.__rafCount = 0;
    const tick = () => requestAnimationFrame(() => { window.__rafCount++; tick(); });
    tick();
    window.scheduleTrial = () => {
      const start = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const endsAt = start + 30 * DAY;
      const id = setInterval(() => {
        if (Date.now() >= endsAt) {
          clearInterval(id);
          window.__expiryIso = new Date().toISOString();
          const b = document.getElementById('banner');
          b.textContent = 'TRIAL EXPIRED — ' + window.__expiryIso.slice(0, 10);
          b.className = 'expired';
        }
      }, DAY);
    };
  </script>
</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-demo2-prof-'));

  try {
    return await withDubSession(profileDir, async ({ browser, client }) => {
      const tab = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab.id, 'Demo 02 Clock');

      const freezeIso = '2026-01-01T09:00:00Z';
      const freezeRes = await client.callTool({ name: 'clock_freeze', arguments: { tab: tab.id, at: freezeIso } });
      assert.notEqual(freezeRes.isError, true, JSON.stringify(freezeRes));

      await browser.evaluate(tab.id, `window.scheduleTrial();`);
      const shotActive = await saveShot(browser, tab.id, 'demo-02-trial-active.png');

      // Step 1 frame, then 20 frames
      const rafBefore = await browser.evaluate(tab.id, `window.__rafCount`);
      const step1 = await client.callTool({ name: 'clock_step', arguments: { tab: tab.id, frames: 1 } });
      assert.notEqual(step1.isError, true, JSON.stringify(step1));
      assert.equal(await browser.evaluate(tab.id, `window.__rafCount`), rafBefore + 1);

      const step20 = await client.callTool({ name: 'clock_step', arguments: { tab: tab.id, frames: 20 } });
      assert.notEqual(step20.isError, true, JSON.stringify(step20));
      const boxLeft = await browser.evaluate(tab.id, `getComputedStyle(document.getElementById('box')).left`);
      const shotStepped = await saveShot(browser, tab.id, 'demo-02-stepped-animation.png');
      assert.notEqual(shotStepped.sha256, shotActive.sha256, 'Stepping animation must change screenshot');

      // Advance 31 days -> trial expires on day 30
      const adv = await client.callTool({ name: 'clock_advance', arguments: { tab: tab.id, by: '31d' } });
      assert.notEqual(adv.isError, true, JSON.stringify(adv));
      const result = await browser.evaluate(
        tab.id,
        `({ banner: document.getElementById('banner').textContent, expiryIso: window.__expiryIso, nowIso: new Date().toISOString() })`
      );
      assert.ok(result.banner.startsWith('TRIAL EXPIRED'), `Unexpected banner: ${result.banner}`);
      const shotExpired = await saveShot(browser, tab.id, 'demo-02-trial-expired.png');
      assert.notEqual(shotExpired.sha256, shotStepped.sha256, 'Trial expiry must change screenshot');

      return {
        id: 'DEMO-02',
        passed: true,
        boxLeftAfterStep: boxLeft,
        observedState: result,
        screenshots: [shotActive, shotStepped, shotExpired],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDemo03() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cookie = req.headers.cookie || '';
    if (url.pathname === '/login') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'dub_demo_user=will; Path=/; Max-Age=3600',
      }).end('<!doctype html><html><head><title>Signed In</title></head><body>Signed in</body></html>');
      return;
    }
    const signedIn = cookie.includes('dub_demo_user=will');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Demo 03 Act As You</title>
<style>body{font-family:system-ui,sans-serif;padding:24px;background:#f8fafc;color:#0f172a}
button{padding:10px 18px;font-size:16px;background:#2563eb;color:#fff;border:0;border-radius:8px;cursor:pointer}
.status{margin-top:16px;padding:12px;border-radius:8px;background:#e2e8f0}</style>
</head>
<body>
  <h1>Dub Demo 03 — Act As You (Persistent Profile + Native Actor + WebMCP)</h1>
  <p>Session: <strong id="session">${signedIn ? 'signed-in:will' : 'anonymous'}</strong></p>
  <button id="approve-btn">Approve</button>
  <div id="expense" class="status">No expense submitted yet</div>
  <div id="approval" class="status">Waiting for approval</div>
  <script>
    window.__approvedTrusted = false;
    document.getElementById('approve-btn').addEventListener('click', (e) => {
      window.__approvedTrusted = e.isTrusted;
      document.getElementById('approval').textContent = 'Approved (isTrusted=' + e.isTrusted + ')';
    });
    const mc = navigator.modelContext || document.modelContext;
    if (mc && typeof mc.registerTool === 'function') {
      mc.registerTool({
        name: 'submit_expense',
        description: 'Submit an expense report for the signed-in user',
        inputSchema: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            memo: { type: 'string' },
          },
          required: ['amount', 'memo'],
        },
        execute: async ({ amount, memo }) => {
          document.getElementById('expense').textContent = 'Submitted $' + amount.toFixed(2) + ' — ' + memo;
          return { submitted: true, amount, memo };
        },
      });
    }
  </script>
</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-demo3-prof-'));

  try {
    // Session 1: sign in to persistent fixture profile
    await withDubSession(profileDir, async ({ browser }) => {
      const tab = await browser.open(`${baseUrl}/login`);
      await waitLoaded(browser, tab.id, 'Signed In');
    });

    // Session 2: restart Dub with the same persistent profile, discover + invoke WebMCP + native actor.click
    return await withDubSession(profileDir, async ({ browser, client }) => {
      const attachRes = await client.callTool({
        name: 'profile_attach',
        arguments: { name: 'Default', dir: profileDir },
      });
      assert.notEqual(attachRes.isError, true, JSON.stringify(attachRes));

      const tab = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab.id, 'Demo 03 Act As You');
      await delay(150);

      const toolsRes = await client.callTool({ name: 'tools_list', arguments: { tab: tab.id } });
      assert.notEqual(toolsRes.isError, true, JSON.stringify(toolsRes));
      const toolsData = JSON.parse(toolsRes.content[0].text);
      const toolNames = (toolsData.tools ?? []).map(t => t.name);
      assert.ok(toolNames.includes('actor.click'), `Expected actor.click in ${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes('page.submit_expense'), `Expected page.submit_expense in ${JSON.stringify(toolNames)}`);

      const expenseRes = await client.callTool({
        name: 'tools_call',
        arguments: {
          tab: tab.id,
          name: 'page.submit_expense',
          input: JSON.stringify({ amount: 42.1, memo: 'team lunch' }),
        },
      });
      assert.notEqual(expenseRes.isError, true, JSON.stringify(expenseRes));

      const clickRes = await client.callTool({
        name: 'tools_call',
        arguments: {
          tab: tab.id,
          name: 'actor.click',
          input: JSON.stringify({ target: '#approve-btn' }),
        },
      });
      assert.notEqual(clickRes.isError, true, JSON.stringify(clickRes));

      const state = await browser.evaluate(
        tab.id,
        `({
          session: document.getElementById('session').textContent,
          expense: document.getElementById('expense').textContent,
          approval: document.getElementById('approval').textContent,
          approvedTrusted: window.__approvedTrusted,
        })`
      );
      assert.equal(state.session, 'signed-in:will', 'Persistent profile cookie must survive restart');
      assert.equal(state.expense, 'Submitted $42.10 — team lunch');
      assert.equal(state.approvedTrusted, true, 'Native actor.click must dispatch isTrusted=true');

      const shot = await saveShot(browser, tab.id, 'demo-03-act-as-you.png');
      return {
        id: 'DEMO-03',
        passed: true,
        discoveredToolsCount: toolNames.length,
        observedState: state,
        screenshots: [shot],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

const startedAt = new Date().toISOString();
const results = [];
results.push(await runDemo01());
results.push(await runDemo02());
results.push(await runDemo03());

const receipt = {
  generatedAt: new Date().toISOString(),
  startedAt,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  demos: results,
};
await writeFile(join(outDir, 'demos-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));

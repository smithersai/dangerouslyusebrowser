import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCommands, launch, listen } from '../../dist/index.js';

const DUB_BROWSER = process.env.DUB_BROWSER;

async function startFixtureServer(t) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/user') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' })
        .end(JSON.stringify({ role: 'guest', name: 'Original User' }));
      return;
    }
    if (url.pathname === '/api/blocked') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"reached":true}');
      return;
    }
    if (url.pathname === '/api/old') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"endpoint":"old"}');
      return;
    }
    if (url.pathname === '/api/new') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"endpoint":"new"}');
      return;
    }
    if (url.pathname === '/static/app.123.js') {
      const js = 'window.__APP_CONFIG = { retries:0, version: "1.0" };';
      const gz = gzipSync(Buffer.from(js));
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=3600',
      }).end(gz);
      return;
    }
    if (url.pathname === '/worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(`
        self.onmessage = async (e) => {
          const r = await fetch(e.data.url);
          self.postMessage(await r.json());
        };
      `);
      return;
    }
    if (url.pathname === '/shared-worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(`
        onconnect = (e) => {
          const port = e.ports[0];
          port.onmessage = async (ev) => {
            const r = await fetch(ev.data.url);
            port.postMessage(await r.json());
          };
        };
      `);
      return;
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(`
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', (e) => {
          const u = new URL(e.request.url);
          if (u.pathname === '/sw-proxy-user') {
            e.respondWith(fetch('/api/user'));
          }
        });
      `);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dub Network Fixture</title>
<script src="/static/app.123.js"></script>
</head>
<body><h1>Dub Network Test</h1></body>
</html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}` };
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

test('Milestone 2 (NET-01..05 & DEMO-01): mock, block, redirect, gzip JS patch across tabs, workers, SW & cache', async t => {
  assert.ok(DUB_BROWSER, 'DUB_BROWSER must be set');
  const fixture = await startFixtureServer(t);
  const workDir = await mkdtemp(join(tmpdir(), 'dub-m2-'));
  const socket = join(workDir, 'sock', 'dub.sock');
  const profile = join(workDir, 'profile');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const session = await launch({
    browser: DUB_BROWSER,
    socket,
    profile,
    headless: process.env.DUB_HEADLESS !== '0',
  });
  t.after(() => session.close());

  const { browser } = session;
  const server = await listen(
    createCommands(browser, { methods: session.info.methods, tools: session.info.tools }).fetch,
    { port: 0, health: () => session.health() }
  );
  t.after(() => server.close());

  const client = new Client({ name: 'dub-m2-mcp', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client.close());

  // 1. Load baseline page first (primes HTTP disk cache + Blink MemoryCache + V8 code cache!)
  const tab = await browser.open(fixture.url);
  await waitLoaded(browser, tab.id, 'Dub Network Fixture');
  assert.equal(await browser.evaluate(tab.id, 'window.__APP_CONFIG.retries'), 0);
  assert.deepEqual(await browser.evaluate(tab.id, `fetch('/api/user').then(r => r.json())`), {
    role: 'guest',
    name: 'Original User',
  });

  // 2. DEMO-01 via real MCP client: mock /api/user to admin + hot-patch gzipped /static/app.*.js!
  const mockRes = await client.callTool({
    name: 'net_mock',
    arguments: {
      match: '*/api/user',
      status: 200,
      body: JSON.stringify({ role: 'admin', name: 'Dub Admin' }),
      contentType: 'application/json',
    },
  });
  assert.notEqual(mockRes.isError, true, JSON.stringify(mockRes));
  const mockRule = JSON.parse(mockRes.content[0].text);

  const patchRes = await client.callTool({
    name: 'net_patch',
    arguments: { match: '*/static/app.*.js', replace: 'retries:0', with: 'retries:3' },
  });
  assert.notEqual(patchRes.isError, true, JSON.stringify(patchRes));

  const blockRes = await client.callTool({ name: 'net_block', arguments: { match: '*/api/blocked' } });
  assert.notEqual(blockRes.isError, true, JSON.stringify(blockRes));

  const redirRes = await client.callTool({
    name: 'net_redirect',
    arguments: { match: '*/api/old', url: `${fixture.url}/api/new` },
  });
  assert.notEqual(redirRes.isError, true, JSON.stringify(redirRes));

  // Verify live mock, block, redirect, and gzipped JS patch (even over previously cached assets!)
  await browser.navigate(tab.id, fixture.url);
  await waitLoaded(browser, tab.id, 'Dub Network Fixture');

  assert.equal(
    await browser.evaluate(tab.id, 'window.__APP_CONFIG.retries'),
    3,
    'Gzipped JS bundle must be live-patched even after cache priming'
  );
  assert.deepEqual(await browser.evaluate(tab.id, `fetch('/api/user').then(r => r.json())`), {
    role: 'admin',
    name: 'Dub Admin',
  });
  assert.deepEqual(await browser.evaluate(tab.id, `fetch('/api/old').then(r => r.json())`), {
    endpoint: 'new',
  });
  const blockedOk = await browser.evaluate(
    tab.id,
    `fetch('/api/blocked').then(() => 'reached', () => 'blocked')`
  );
  assert.equal(blockedOk, 'blocked');

  // 3. NET-02: Dedicated Worker, Shared Worker, and Service Worker outbound fetch
  const workerUser = await browser.evaluate(
    tab.id,
    `new Promise((resolve, reject) => {
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { w.terminate(); resolve(e.data); };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ url: '/api/user' });
    })`
  );
  assert.deepEqual(workerUser, { role: 'admin', name: 'Dub Admin' }, 'Dedicated worker fetch must be intercepted');

  const sharedWorkerUser = await browser.evaluate(
    tab.id,
    `new Promise((resolve, reject) => {
      const sw = new SharedWorker('/shared-worker.js');
      sw.port.onmessage = (e) => resolve(e.data);
      sw.onerror = (e) => reject(new Error(e.message));
      sw.port.start();
      sw.port.postMessage({ url: '/api/user' });
    })`
  );
  assert.deepEqual(sharedWorkerUser, { role: 'admin', name: 'Dub Admin' }, 'SharedWorker fetch must be intercepted');

  const swUser = await browser.evaluate(
    tab.id,
    `(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        });
      }
      const r = await fetch('/sw-proxy-user');
      return await r.json();
    })()`
  );
  assert.deepEqual(swUser, { role: 'admin', name: 'Dub Admin' }, 'ServiceWorker outbound fetch must be intercepted');

  // 4. NET-05: List rules, inspect log with sequence cursor, remove rule -> restores live server
  const listRes = await browser.rules();
  assert.equal(listRes.rules.length, 4);

  const log1 = await browser.networkLog('/api/user', 0);
  assert.ok(log1.entries.some(e => e.action === 'mock' && e.ruleId === mockRule.id && e.status === 200));
  const patchLog = await browser.networkLog('app.123.js', 0);
  assert.ok(patchLog.entries.some(e => e.action === 'patch' && e.patched === true));

  await browser.removeRule(mockRule.id);
  const restored = await browser.evaluate(tab.id, `fetch('/api/user', { cache: 'no-store' }).then(r => r.json())`);
  assert.deepEqual(restored, { role: 'guest', name: 'Original User' });
});

#!/usr/bin/env node
/**
 * Captures REAL screenshots and REAL MCP tool outputs from the compiled Dub Chromium 157 fork
 * for all 3 video demo use cases:
 *   1. Hot-patch a prod JS bug behind a Service Worker (before + after)
 *   2. Time-travel a 30-day SaaS trial + deterministic CSS frame stepping in Tab 1
 *      while Tab 2 stays on real wall time (same renderer / session)
 *   3. Act as you: Persistent signed-in profile + WebMCP (page.submit_expense) + Native Actor (actor.click)
 *
 * Usage:
 *   DUB_BROWSER=~/chromium/src/out/Default/chrome \
 *   DUB_REPO=~/work/dangerouslyusebrowser \
 *   node capture-frames.mjs --out-dir /tmp/dub-video-demo/captures
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DUB_BROWSER = process.env.DUB_BROWSER;
const DUB_REPO = resolve(process.env.DUB_REPO || '.');
if (!DUB_BROWSER) {
  console.error('Error: set DUB_BROWSER=/path/to/chrome');
  process.exit(1);
}

const { Client } = await import(pathToFileURL(join(DUB_REPO, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(DUB_REPO, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')).href);
const { createCommands, launch, listen } = await import(pathToFileURL(join(DUB_REPO, 'dist/index.js')).href);

let outDir = resolve('/tmp/dub-video-demo/captures');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out-dir') outDir = resolve(process.argv[++i]);
}
await mkdir(outDir, { recursive: true });

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function saveShot(browser, tabId, filename) {
  const shot = await browser.screenshot(tabId);
  const buf = Buffer.from(shot.data, 'base64');
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename} must be a valid PNG`);
  const path = join(outDir, filename);
  await writeFile(path, buf);
  return { filename, bytes: buf.length, sha256: sha256(buf).slice(0, 12) };
}

async function waitLoaded(browser, tabId, expectedTitle) {
  for (let i = 0; i < 80; i++) {
    const { tabs } = await browser.tabs();
    const tab = tabs.find(t => t.id === tabId);
    if (tab && !tab.loading && (!expectedTitle || tab.title === expectedTitle)) return tab;
    await delay(100);
  }
  throw new Error(`Timed out waiting for tab ${tabId} (${expectedTitle || 'any'})`);
}

async function withDubSession(profileDir, fn) {
  const work = await mkdtemp(join(tmpdir(), 'dub-vid-'));
  const socket = join(work, 'dub.sock');
  const session = await launch({
    browser: DUB_BROWSER,
    profile: profileDir,
    socket,
    headless: true,
    timeoutMs: 20_000,
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
  const client = new Client({ name: 'dub-video-capture', version: '0.1.0' });
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

/* ============================================================================
 * USE CASE 1: Hot-patch a prod JS bug behind an active Service Worker
 * Realistic "Acme Cloud Billing" dashboard (780x493 viewport)
 * ============================================================================ */
async function captureUseCase1() {
  console.log('[UC1] Starting Acme Cloud Billing with active Service Worker...');
  const swCode = `
    const CACHE = 'acme-billing-v4';
    self.addEventListener('install', (e) => {
      self.skipWaiting();
    });
    self.addEventListener('activate', (e) => {
      e.waitUntil(self.clients.claim());
    });
    self.addEventListener('fetch', (e) => {
      const url = new URL(e.request.url);
      if (url.pathname === '/v1/user' || url.pathname.startsWith('/static/')) {
        e.respondWith(
          fetch(e.request, { cache: 'no-store' }).then((resp) => {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
            return resp;
          })
        );
      }
    });
  `;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Acme Cloud Billing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 780px; height: 493px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: #0b1120; color: #f1f5f9;
    display: flex; flex-direction: column;
  }
  .topbar {
    height: 52px; padding: 0 22px;
    background: #111827; border-bottom: 1px solid #1e293b;
    display: flex; align-items: center; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
  .logo {
    width: 26px; height: 26px; border-radius: 7px;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; color: #fff;
  }
  .sw-pill {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: rgba(16, 185, 129, 0.14); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; }
  .main { padding: 20px 22px; display: flex; flex-direction: column; gap: 16px; flex: 1; }
  .header-row { display: flex; align-items: center; justify-content: space-between; }
  h1 { font-size: 20px; font-weight: 700; color: #f8fafc; }
  .sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .card {
    background: #131c31; border: 1px solid #1f2e4d; border-radius: 12px;
    padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  }
  .card.ok { border-color: rgba(16, 185, 129, 0.45); background: linear-gradient(180deg, #131c31 0%, rgba(16,185,129,0.08) 100%); }
  .card.err { border-color: rgba(239, 68, 68, 0.45); background: linear-gradient(180deg, #131c31 0%, rgba(239,68,68,0.08) 100%); }
  .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; }
  .val-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .val { font-size: 22px; font-weight: 700; color: #f8fafc; }
  .badge {
    padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700;
  }
  .badge.warn { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
  .badge.err { background: rgba(239, 68, 68, 0.18); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
  .badge.ok { background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    background: #0b1120; border: 1px solid #1e293b; border-radius: 8px;
    padding: 9px 12px; color: #cbd5e1;
  }
  .mono .hl-err { color: #f87171; font-weight: 700; }
  .mono .hl-ok { color: #34d399; font-weight: 700; }
  .banner {
    border-radius: 12px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
    font-size: 13px; font-weight: 500;
  }
  .banner.err { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: #fecaca; }
  .banner.ok { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); color: #a7f3d0; }
  .btn {
    padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; border: 0;
  }
  .btn.disabled { background: #1e293b; color: #64748b; }
  .btn.enabled { background: #10b981; color: #052e16; }
  .footer-meta {
    margin-top: auto; display: flex; justify-content: space-between;
    font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; padding-top: 10px;
  }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brand"><div class="logo">A</div>Acme Cloud Billing</div>
    <div class="sw-pill"><span class="dot"></span><span id="sw-status">Service Worker: Activating...</span></div>
  </div>
  <div class="main">
    <div class="header-row">
      <div>
        <h1>Production Billing Controls</h1>
        <div class="sub">billing.acme.io · Bundle /static/app.4f9a.js · API /v1/user</div>
      </div>
      <div id="plan-pill" class="badge warn">Standard</div>
    </div>

    <div class="grid">
      <div id="role-card" class="card err">
        <div class="label">Authenticated Role (/v1/user)</div>
        <div class="val-row">
          <div id="role-val" class="val">loading...</div>
          <span id="role-badge" class="badge warn">Read-Only</span>
        </div>
        <div id="role-json" class="mono">{"user":"alice","role":"viewer"}</div>
      </div>

      <div id="retry-card" class="card err">
        <div class="label">Webhook Retry Policy (/static/app.4f9a.js)</div>
        <div class="val-row">
          <div id="retry-val" class="val">retries: ...</div>
          <span id="retry-badge" class="badge err">BUG #418</span>
        </div>
        <div id="retry-code" class="mono">window.APP_CONFIG = { <span class="hl-err">retries: 0</span> };</div>
      </div>
    </div>

    <div id="status-banner" class="banner err">
      <div id="banner-text">⚠ Checkout webhook drops invoices on transient 503 (retries: 0). Admin override locked for viewer role.</div>
      <button id="action-btn" class="btn disabled">Admin Controls Locked</button>
    </div>

    <div class="footer-meta">
      <span>Intercept layer: Chromium NetworkService</span>
      <span id="cache-meta">CacheStorage: acme-billing-v4</span>
    </div>
  </div>
  <script src="/static/app.4f9a.js"></script>
  <script>
    async function boot() {
      if ('serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          document.getElementById('sw-status').textContent = 'Service Worker: ACTIVE (Cache-First)';
        } catch (e) {
          document.getElementById('sw-status').textContent = 'Service Worker: Error';
        }
      }
      const retries = window.APP_CONFIG ? window.APP_CONFIG.retries : -1;
      document.getElementById('retry-val').textContent = 'retries: ' + retries;
      const isPatched = retries >= 3;
      document.getElementById('retry-card').className = 'card ' + (isPatched ? 'ok' : 'err');
      document.getElementById('retry-badge').className = 'badge ' + (isPatched ? 'ok' : 'err');
      document.getElementById('retry-badge').textContent = isPatched ? 'HOT-PATCHED' : 'BUG #418';
      document.getElementById('retry-code').innerHTML = isPatched
        ? 'window.APP_CONFIG = { <span class="hl-ok">retries: ' + retries + '</span> };'
        : 'window.APP_CONFIG = { <span class="hl-err">retries: ' + retries + '</span> };';

      const res = await fetch('/v1/user');
      const d = await res.json();
      window.__user = d;
      const isAdmin = d.role === 'admin';
      document.getElementById('role-val').textContent = isAdmin ? 'Admin (Enterprise)' : 'Viewer';
      document.getElementById('role-card').className = 'card ' + (isAdmin ? 'ok' : 'err');
      document.getElementById('role-badge').className = 'badge ' + (isAdmin ? 'ok' : 'warn');
      document.getElementById('role-badge').textContent = isAdmin ? 'Full Access' : 'Read-Only';
      document.getElementById('role-json').textContent = JSON.stringify(d);
      document.getElementById('plan-pill').className = 'badge ' + (isAdmin ? 'ok' : 'warn');
      document.getElementById('plan-pill').textContent = isAdmin ? 'Enterprise' : 'Standard';

      const banner = document.getElementById('status-banner');
      const bText = document.getElementById('banner-text');
      const btn = document.getElementById('action-btn');
      if (isAdmin && isPatched) {
        banner.className = 'banner ok';
        bText.textContent = '✓ Live hot-patch active inside NetworkService — retries: 3 healthy, Admin billing controls unlocked.';
        btn.className = 'btn enabled';
        btn.textContent = 'Replay Failed Webhooks';
      }
      window.__uc1Ready = true;
    }
    boot();
  </script>
</body>
</html>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' }).end(swCode);
      return;
    }
    if (url.pathname === '/v1/user') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ user: 'alice', role: 'viewer' }));
      return;
    }
    if (url.pathname === '/static/app.4f9a.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }).end('window.APP_CONFIG = {retries:0};');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-vid-uc1-'));

  try {
    return await withDubSession(profileDir, async ({ browser, client, work }) => {
      // 1) Open page BEFORE rewrite/patch -> SW installs & activates
      const tab = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab.id, 'Acme Cloud Billing');
      for (let i = 0; i < 40; i++) {
        const ready = await browser.evaluate(tab.id, `Boolean(window.__uc1Ready)`);
        if (ready) break;
        await delay(100);
      }
      await delay(200);
      // Reload once so SW is actively controlling the page
      await browser.open(`${baseUrl}/`);
      const tabCtrl = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tabCtrl.id, 'Acme Cloud Billing');
      for (let i = 0; i < 40; i++) {
        const ready = await browser.evaluate(tabCtrl.id, `Boolean(window.__uc1Ready)`);
        if (ready) break;
        await delay(100);
      }
      await delay(200);
      const beforeState = await browser.evaluate(tabCtrl.id, `({
        role: window.__user?.role,
        retries: window.APP_CONFIG?.retries,
        swControlled: Boolean(navigator.serviceWorker?.controller),
      })`);
      console.log('[UC1] BEFORE state:', beforeState);
      const shotBefore = await saveShot(browser, tabCtrl.id, 'uc1-before.png');

      // 2) Apply Dub net_rewrite + net_patch at NetworkService layer
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

      // 3) Open fresh tab (still controlled by the active Service Worker!) -> verify patched!
      const tabAfter = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tabAfter.id, 'Acme Cloud Billing');
      for (let i = 0; i < 40; i++) {
        const ready = await browser.evaluate(tabAfter.id, `Boolean(window.__uc1Ready)`);
        if (ready) break;
        await delay(100);
      }
      await delay(250);
      const afterState = await browser.evaluate(tabAfter.id, `({
        role: window.__user?.role,
        retries: window.APP_CONFIG?.retries,
        swControlled: Boolean(navigator.serviceWorker?.controller),
      })`);
      console.log('[UC1] AFTER state:', afterState);
      assert.equal(afterState.role, 'admin', 'API response must be rewritten to admin even with SW');
      assert.equal(afterState.retries, 3, 'JS bundle must be patched to retries:3 even with SW');

      const shotAfter = await saveShot(browser, tabAfter.id, 'uc1-after.png');
      return {
        beforeState,
        afterState,
        shots: [shotBefore, shotAfter],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============================================================================
 * USE CASE 2: Time-travel a 30-day SaaS trial + step CSS animations in Tab 1
 * while Tab 2 stays on real wall time!
 * ============================================================================ */
async function captureUseCase2() {
  console.log('[UC2] Starting Billing Trial UI (Tab 1) + Live Control Tab (Tab 2)...');
  const trialHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Acme Pro Trial</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 780px; height: 493px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: #0b1120; color: #f1f5f9; position: relative;
    display: flex; flex-direction: column;
  }
  .topbar {
    height: 50px; padding: 0 22px; background: #111827; border-bottom: 1px solid #1e293b;
    display: flex; align-items: center; justify-content: space-between;
  }
  .brand { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; }
  .pill-tab {
    padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700;
    background: rgba(56, 189, 248, 0.16); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35);
  }
  .clock-readout {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #94a3b8;
  }
  .main { padding: 20px 22px; display: flex; flex-direction: column; gap: 16px; flex: 1; }
  .banner {
    padding: 16px 20px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between;
    background: linear-gradient(90deg, rgba(16,185,129,0.18), rgba(6,182,212,0.12));
    border: 1px solid rgba(16,185,129,0.4);
  }
  .banner.expired {
    background: linear-gradient(90deg, rgba(239,68,68,0.22), rgba(220,38,38,0.12));
    border-color: rgba(239,68,68,0.55);
  }
  .banner-title { font-size: 19px; font-weight: 800; color: #f8fafc; }
  .banner-sub { font-size: 12px; color: #cbd5e1; margin-top: 3px; }
  .days-pill {
    padding: 6px 12px; border-radius: 8px; font-size: 13px; font-weight: 700;
    background: #10b981; color: #052e16;
  }
  .banner.expired .days-pill { background: #ef4444; color: #fff; }
  .anim-card {
    background: #131c31; border: 1px solid #1f2e4d; border-radius: 12px; padding: 18px 20px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .anim-head { display: flex; justify-content: space-between; align-items: center; }
  .anim-title { font-size: 14px; font-weight: 700; color: #e2e8f0; }
  .raf-badge {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    padding: 4px 10px; border-radius: 6px; background: #0b1120; border: 1px solid #334155; color: #38bdf8;
  }
  .track {
    position: relative; height: 64px; background: #0b1120; border: 1px solid #1e293b;
    border-radius: 10px; overflow: hidden;
  }
  .fill {
    position: absolute; left: 0; top: 0; bottom: 0; width: 40px;
    background: linear-gradient(90deg, #2563eb, #06b6d4);
  }
  .fill.running { animation: grow 1s linear forwards; }
  .orb {
    position: absolute; left: 16px; top: 10px; width: 44px; height: 44px; border-radius: 10px;
    background: #f8fafc; box-shadow: 0 0 20px rgba(56, 189, 248, 0.8);
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 12px; color: #0f172a;
  }
  .orb.running { animation: slide 1s linear forwards; }
  @keyframes grow { from { width: 40px; } to { width: 694px; } }
  @keyframes slide { from { left: 16px; } to { left: 634px; } }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .m {
    background: #131c31; border: 1px solid #1f2e4d; border-radius: 10px; padding: 12px 14px;
  }
  .m-lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .m-val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 16px; font-weight: 700; color: #f8fafc; margin-top: 4px; }
  /* Modal overlay when trial expires */
  .modal-backdrop {
    display: none; position: absolute; inset: 0;
    background: rgba(2, 6, 23, 0.78);
    align-items: center; justify-content: center;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    width: 490px; background: #131c31; border: 1px solid rgba(239, 68, 68, 0.6);
    border-radius: 16px; padding: 26px 28px; box-shadow: 0 24px 60px rgba(0,0,0,0.65);
    display: flex; flex-direction: column; gap: 14px;
  }
  .modal-badge {
    align-self: flex-start; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800;
    background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.45);
    letter-spacing: 0.06em;
  }
  .modal h2 { font-size: 24px; font-weight: 800; color: #fff; }
  .modal p { font-size: 14px; color: #cbd5e1; line-height: 1.5; }
  .modal-meta {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    background: #0b1120; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 12px; color: #38bdf8;
  }
  .modal-btn {
    margin-top: 4px; padding: 12px 18px; border-radius: 10px; border: 0;
    background: linear-gradient(90deg, #3b82f6, #06b6d4); color: #fff;
    font-size: 14px; font-weight: 700; text-align: center;
  }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brand"><span class="pill-tab">TAB 1 · FROZEN</span> Acme Pro Trial</div>
    <div id="clock-iso" class="clock-readout">2026-01-01T09:00:00.000Z</div>
  </div>
  <div class="main">
    <div id="banner" class="banner">
      <div>
        <div id="banner-title" class="banner-title">TRIAL ACTIVE — 2026-01-01</div>
        <div id="banner-sub" class="banner-sub">30-day Enterprise evaluation · Expires 2026-01-31</div>
      </div>
      <div id="days-pill" class="days-pill">30 days left</div>
    </div>

    <div class="anim-card">
      <div class="anim-head">
        <div class="anim-title">60fps CSS @keyframes Progress Animation (Blink Animation Clock)</div>
        <div id="raf-badge" class="raf-badge">rAF #0 · 0.0%</div>
      </div>
      <div class="track">
        <div id="fill" class="fill"></div>
        <div id="orb" class="orb">CSS</div>
      </div>
    </div>

    <div class="metrics">
      <div class="m"><div class="m-lbl">Date.now()</div><div id="m-date" class="m-val">2026-01-01</div></div>
      <div class="m"><div class="m-lbl">CSS left (px)</div><div id="m-left" class="m-val">16.0px</div></div>
      <div class="m"><div class="m-lbl">Clock Scope</div><div class="m-val" style="color:#34d399">Tab 1 Only</div></div>
    </div>
  </div>

  <div id="expired-modal" class="modal-backdrop">
    <div class="modal">
      <span class="modal-badge">30-DAY TRIAL ENDED</span>
      <h2>TRIAL EXPIRED — Upgrade to Pro</h2>
      <p>Your 30-day Acme Enterprise trial ended on <strong>2026-01-31</strong>. Upgrade now to keep your production workspaces running.</p>
      <div id="modal-meta" class="modal-meta">Triggered at: 2026-01-31T09:00:00.000Z</div>
      <div class="modal-btn">Upgrade to Pro — $49/mo</div>
    </div>
  </div>

  <script>
    window.__rafCount = 0;
    const updateReadouts = () => {
      const iso = new Date().toISOString();
      document.getElementById('clock-iso').textContent = iso;
      document.getElementById('m-date').textContent = iso.slice(0, 10);
      const leftPx = parseFloat(getComputedStyle(document.getElementById('orb')).left) || 16;
      const pct = Math.max(0, Math.min(100, ((leftPx - 16) / (634 - 16)) * 100));
      document.getElementById('m-left').textContent = leftPx.toFixed(1) + 'px';
      document.getElementById('raf-badge').textContent = 'rAF #' + window.__rafCount + ' · ' + pct.toFixed(0) + '%';
    };
    const tick = () => requestAnimationFrame(() => {
      window.__rafCount++;
      updateReadouts();
      tick();
    });
    tick();

    window.scheduleTrial = () => {
      document.getElementById('fill').classList.add('running');
      document.getElementById('orb').classList.add('running');
      const start = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const endsAt = start + 30 * DAY;
      updateReadouts();
      const id = setInterval(() => {
        updateReadouts();
        if (Date.now() >= endsAt) {
          clearInterval(id);
          window.__expiryIso = new Date().toISOString();
          document.getElementById('banner').className = 'banner expired';
          document.getElementById('banner-title').textContent = 'TRIAL EXPIRED — ' + window.__expiryIso.slice(0, 10);
          document.getElementById('days-pill').textContent = '0 days left';
          document.getElementById('modal-meta').textContent = 'Triggered at: ' + window.__expiryIso + ' (setInterval fired deterministically)';
          document.getElementById('expired-modal').className = 'modal-backdrop open';
        }
      }, DAY);
    };
  </script>
</body>
</html>`;

  const controlHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Live Control Tab</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 780px; height: 493px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: #0b1120; color: #f1f5f9;
    display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 18px;
    padding: 28px;
  }
  .pill {
    padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 700;
    background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);
  }
  .time {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 38px; font-weight: 800; color: #f8fafc;
  }
  .sub { font-size: 15px; color: #94a3b8; }
</style>
</head>
<body>
  <div class="pill">● TAB 2 · LIVE WALL CLOCK (UNAFFECTED)</div>
  <div id="live-clock" class="time">--:--:--</div>
  <div id="live-date" class="sub">Real-time system clock ticking normally</div>
  <script>
    const fmt = () => {
      const now = new Date();
      document.getElementById('live-clock').textContent = now.toISOString().slice(11, 22) + ' UTC';
      document.getElementById('live-date').textContent = 'Real wall date: ' + now.toISOString().slice(0, 10) + ' · Same Chromium process';
    };
    fmt();
    setInterval(fmt, 50);
  </script>
</body>
</html>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/control') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(controlHtml);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(trialHtml);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-vid-uc2-'));

  try {
    return await withDubSession(profileDir, async ({ browser, client }) => {
      // Open Tab 2 (Live Control Tab) first, then Tab 1 so Tab 1 is foreground active for compositing!
      const tab2 = await browser.open(`${baseUrl}/control`);
      await waitLoaded(browser, tab2.id, 'Live Control Tab');
      await delay(150);
      const tab2StartIso = await browser.evaluate(tab2.id, `new Date().toISOString()`);
      const shotTab2Start = await saveShot(browser, tab2.id, 'uc2-tab2-start.png');

      const tab1 = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab1.id, 'Acme Pro Trial');

      const freezeIso = '2026-01-01T09:00:00Z';
      const freezeRes = await client.callTool({ name: 'clock_freeze', arguments: { tab: tab1.id, at: freezeIso } });
      assert.notEqual(freezeRes.isError, true, JSON.stringify(freezeRes));

      await browser.evaluate(tab1.id, `window.scheduleTrial();`);
      const shotActive = await saveShot(browser, tab1.id, 'uc2-tab1-frozen.png');

      // Capture 12 real stepped animation frames (5 frames each -> 60 frames = 1.0s full CSS slide!)
      const stepShots = [];
      let prevHash = shotActive.sha256;
      for (let i = 1; i <= 12; i++) {
        const stepRes = await client.callTool({ name: 'clock_step', arguments: { tab: tab1.id, frames: 5 } });
        assert.notEqual(stepRes.isError, true, JSON.stringify(stepRes));
        const shot = await saveShot(browser, tab1.id, `uc2-tab1-step-${String(i).padStart(2, '0')}.png`);
        const left = await browser.evaluate(tab1.id, `getComputedStyle(document.getElementById('orb')).left`);
        assert.notEqual(shot.sha256, prevHash, `Step ${i} screenshot must visually advance`);
        prevHash = shot.sha256;
        stepShots.push({ ...shot, left });
      }

      // Advance 31 days -> trial expires on day 30!
      const advRes = await client.callTool({ name: 'clock_advance', arguments: { tab: tab1.id, by: '31d' } });
      assert.notEqual(advRes.isError, true, JSON.stringify(advRes));
      const tab1Result = await browser.evaluate(tab1.id, `({
        expiryIso: window.__expiryIso,
        nowIso: new Date().toISOString(),
        modalOpen: document.getElementById('expired-modal').classList.contains('open'),
      })`);
      const tab2EndIso = await browser.evaluate(tab2.id, `new Date().toISOString()`);
      assert.equal(tab1Result.modalOpen, true, 'Expired modal must open');
      const shotExpired = await saveShot(browser, tab1.id, 'uc2-tab1-expired.png');
      assert.notEqual(shotExpired.sha256, prevHash, 'Expired modal screenshot must differ from last step');

      // Switch back to Tab 2 to capture live wall clock screenshot
      await client.callTool({
        name: 'tools_call',
        arguments: { tab: tab1.id, name: 'actor.switch_tab', input: JSON.stringify({ tabId: tab2.id }) },
      }).catch(() => {});
      await delay(150);
      const shotTab2End = await saveShot(browser, tab2.id, 'uc2-tab2-live.png');

      console.log('[UC2] Tab 1 expired:', tab1Result, 'Tab 2 wall clock:', tab2StartIso, '->', tab2EndIso);
      return {
        tab1Result,
        tab2StartIso,
        tab2EndIso,
        shots: [shotActive, ...stepShots, shotExpired, shotTab2Start, shotTab2End],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============================================================================
 * USE CASE 3: Act as you — Persistent signed-in profile + WebMCP + Native Actor
 * ============================================================================ */
async function captureUseCase3() {
  console.log('[UC3] Starting Expense Approval Portal (Persistent Profile + WebMCP + Native Actor)...');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cookie = req.headers.cookie || '';
    if (url.pathname === '/login') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'dub_demo_user=will; Path=/; Max-Age=3600',
      }).end('<!doctype html><html><head><title>Signed In</title></head><body>Signed in as will@acme.io</body></html>');
      return;
    }
    const signedIn = cookie.includes('dub_demo_user=will');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Acme Expense Approvals</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 780px; height: 493px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: #0b1120; color: #f1f5f9;
    display: flex; flex-direction: column;
  }
  .topbar {
    height: 52px; padding: 0 22px; background: #111827; border-bottom: 1px solid #1e293b;
    display: flex; align-items: center; justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
  .logo {
    width: 26px; height: 26px; border-radius: 7px;
    background: linear-gradient(135deg, #8b5cf6, #ec4899);
    display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; color: #fff;
  }
  .user-pill {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: rgba(16, 185, 129, 0.14); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35);
  }
  .avatar {
    width: 20px; height: 20px; border-radius: 50%; background: #10b981; color: #052e16;
    display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800;
  }
  .main { padding: 20px 22px; display: flex; flex-direction: column; gap: 15px; flex: 1; }
  .head-row { display: flex; align-items: center; justify-content: space-between; }
  h1 { font-size: 20px; font-weight: 700; }
  .sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .webmcp-badge {
    padding: 5px 10px; border-radius: 6px; font-size: 11px; font-weight: 700;
    background: rgba(139, 92, 246, 0.18); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.4);
  }
  .card {
    background: #131c31; border: 1px solid #1f2e4d; border-radius: 12px; padding: 18px 20px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .card.submitted { border-color: rgba(56, 189, 248, 0.5); }
  .card.approved { border-color: rgba(16, 185, 129, 0.55); background: linear-gradient(180deg, #131c31 0%, rgba(16,185,129,0.09) 100%); }
  .row { display: flex; align-items: center; justify-content: space-between; }
  .exp-title { font-size: 16px; font-weight: 700; color: #f8fafc; }
  .exp-amt { font-size: 26px; font-weight: 800; color: #f8fafc; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .meta-line { font-size: 12px; color: #94a3b8; }
  .status-pill {
    padding: 5px 11px; border-radius: 6px; font-size: 12px; font-weight: 700;
    background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid #334155;
  }
  .status-pill.pending { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); }
  .status-pill.ok { background: rgba(16, 185, 129, 0.2); color: #34d399; border-color: rgba(16, 185, 129, 0.45); }
  .actions { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; padding-top: 12px; border-top: 1px solid #1e293b; }
  #approve-btn {
    padding: 10px 20px; border-radius: 8px; border: 0; font-size: 14px; font-weight: 700; cursor: pointer;
    background: linear-gradient(90deg, #3b82f6, #2563eb); color: #fff;
    box-shadow: 0 4px 16px rgba(37, 99, 235, 0.35);
  }
  #approve-btn.done { background: #10b981; color: #052e16; box-shadow: none; }
  .audit {
    background: #0b1120; border: 1px solid #1e293b; border-radius: 10px; padding: 13px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #94a3b8;
    display: flex; flex-direction: column; gap: 6px;
  }
  .audit strong { color: #34d399; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brand"><div class="logo">E</div>Acme Expense Approvals</div>
    <div class="user-pill">
      <div class="avatar">W</div>
      <span id="session">${signedIn ? 'Signed in: will@acme.io (Persisted Profile)' : 'anonymous'}</span>
    </div>
  </div>
  <div class="main">
    <div class="head-row">
      <div>
        <h1>Team Expense Queue</h1>
        <div class="sub">expenses.acme.io/approvals · Zero login prompt · Profile cookie persisted</div>
      </div>
      <span class="webmcp-badge">WebMCP Tool: page.submit_expense</span>
    </div>

    <div id="exp-card" class="card">
      <div class="row">
        <div>
          <div id="exp-title" class="exp-title">Waiting for new expense submission...</div>
          <div id="exp-meta" class="meta-line">Ready to receive WebMCP call: navigator.modelContext.registerTool("submit_expense")</div>
        </div>
        <div id="exp-amt" class="exp-amt">$0.00</div>
      </div>
      <div class="actions">
        <span id="approval-pill" class="status-pill">Idle</span>
        <button id="approve-btn">Approve Expense</button>
      </div>
    </div>

    <div class="audit">
      <div>[SESSION] Cookie <strong>dub_demo_user=will</strong> loaded from persistent Dub profile</div>
      <div id="audit-webmcp">[WEBMCP]  Registered tool <strong>page.submit_expense</strong> (waiting for invocation)</div>
      <div id="audit-actor">[ACTOR]   Native Chromium Actor ready (no CDP Runtime.enable)</div>
    </div>
  </div>
  <script>
    window.__approvedTrusted = false;
    document.getElementById('approve-btn').addEventListener('click', (e) => {
      window.__approvedTrusted = e.isTrusted;
      document.getElementById('exp-card').className = 'card approved';
      const pill = document.getElementById('approval-pill');
      pill.className = 'status-pill ok';
      pill.textContent = '✓ APPROVED · isTrusted=' + e.isTrusted;
      const btn = document.getElementById('approve-btn');
      btn.className = 'done';
      btn.textContent = '✓ Approved';
      document.getElementById('audit-actor').innerHTML =
        '[ACTOR]   Native actor.click dispatched — <strong>Event.isTrusted: ' + e.isTrusted + '</strong> · CDP: <strong>false</strong>';
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
          document.getElementById('exp-card').className = 'card submitted';
          document.getElementById('exp-title').textContent = 'EXP-4091 · ' + memo;
          document.getElementById('exp-meta').textContent = 'Submitted by will@acme.io via WebMCP · Ready for manager approval';
          document.getElementById('exp-amt').textContent = '$' + amount.toFixed(2);
          const pill = document.getElementById('approval-pill');
          pill.className = 'status-pill pending';
          pill.textContent = 'Pending Approval';
          document.getElementById('audit-webmcp').innerHTML =
            '[WEBMCP]  Invoked <strong>page.submit_expense</strong>({ amount: ' + amount.toFixed(2) + ', memo: "' + memo + '" })';
          return { submitted: true, id: 'EXP-4091', amount, memo };
        },
      });
    }
  </script>
</body>
</html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'dub-vid-uc3-'));

  try {
    // Session 1: sign in to persistent profile
    await withDubSession(profileDir, async ({ browser }) => {
      const tab = await browser.open(`${baseUrl}/login`);
      await waitLoaded(browser, tab.id, 'Signed In');
    });

    // Session 2: restart Dub with the same persistent profile
    return await withDubSession(profileDir, async ({ browser, client }) => {
      const attachRes = await client.callTool({
        name: 'profile_attach',
        arguments: { name: 'Default', dir: profileDir },
      });
      assert.notEqual(attachRes.isError, true, JSON.stringify(attachRes));

      const tab = await browser.open(`${baseUrl}/`);
      await waitLoaded(browser, tab.id, 'Acme Expense Approvals');
      await delay(150);

      // Shot 1: Already signed in via persistent profile
      const shotSignedIn = await saveShot(browser, tab.id, 'uc3-1-signed-in.png');

      // Discover tools
      const toolsRes = await client.callTool({ name: 'tools_list', arguments: { tab: tab.id } });
      assert.notEqual(toolsRes.isError, true, JSON.stringify(toolsRes));
      const toolsData = JSON.parse(toolsRes.content[0].text);
      const toolNames = (toolsData.tools ?? []).map(t => t.name);
      assert.ok(toolNames.includes('actor.click'), 'actor.click must be discovered');
      assert.ok(toolNames.includes('page.submit_expense'), 'page.submit_expense must be discovered');

      // Invoke WebMCP tool
      const expenseRes = await client.callTool({
        name: 'tools_call',
        arguments: {
          tab: tab.id,
          name: 'page.submit_expense',
          input: JSON.stringify({ amount: 42.1, memo: 'Team lunch' }),
        },
      });
      assert.notEqual(expenseRes.isError, true, JSON.stringify(expenseRes));
      await delay(100);
      const shotSubmitted = await saveShot(browser, tab.id, 'uc3-2-submitted.png');

      // Invoke Native Chromium Actor click
      const clickRes = await client.callTool({
        name: 'tools_call',
        arguments: {
          tab: tab.id,
          name: 'actor.click',
          input: JSON.stringify({ target: '#approve-btn' }),
        },
      });
      assert.notEqual(clickRes.isError, true, JSON.stringify(clickRes));
      await delay(100);
      const shotApproved = await saveShot(browser, tab.id, 'uc3-3-approved.png');

      const state = await browser.evaluate(tab.id, `({
        session: document.getElementById('session').textContent,
        approvedTrusted: window.__approvedTrusted,
      })`);
      console.log('[UC3] Final state:', state, 'Tools:', toolNames.length);
      assert.equal(state.approvedTrusted, true, 'Native actor.click must dispatch isTrusted=true');

      return {
        toolNames,
        state,
        shots: [shotSignedIn, shotSubmitted, shotApproved],
      };
    });
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

const uc1 = await captureUseCase1();
const uc2 = await captureUseCase2();
const uc3 = await captureUseCase3();

const manifest = {
  generatedAt: new Date().toISOString(),
  uc1,
  uc2,
  uc3,
};
await writeFile(join(outDir, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('ALL CAPTURES SUCCEEDED:', JSON.stringify(manifest, null, 2));

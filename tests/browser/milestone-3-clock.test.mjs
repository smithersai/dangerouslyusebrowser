import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
    if (url.pathname === '/worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end(`
        self.onmessage = () => {
          self.postMessage({
            iso: new Date().toISOString(),
            dateNow: Date.now(),
            perfNow: performance.now(),
          });
        };
      `);
      return;
    }
    if (url.pathname === '/control') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html><head><title>Control Tab</title></head>
<body>
<div id="status">control</div>
<script>
  window.__controlTimerFired = false;
  window.startControlTimer = () => {
    window.__controlTimerFired = false;
    setTimeout(() => { window.__controlTimerFired = true; }, 80);
  };
</script>
</body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dub Clock Fixture</title>
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; font-family: sans-serif; }
  #banner { padding: 12px; font-size: 20px; background: #22c55e; color: #fff; }
  #banner.expired { background: #dc2626; }
  #box {
    position: absolute;
    left: 20px;
    top: 100px;
    width: 80px;
    height: 80px;
    background: #2563eb;
    animation: slide 1s linear forwards;
  }
  @keyframes slide {
    from { left: 20px; }
    to { left: 620px; }
  }
</style>
</head>
<body>
<div id="banner">TRIAL ACTIVE</div>
<button id="open-control" style="margin:8px;padding:6px 12px" onclick="window.__child = window.open('/control', '_blank')">Open Control</button>
<div id="box"></div>
<script>
  window.__rafCount = 0;
  window.__rafTimestamps = [];
  window.__tickRaf = () => {
    requestAnimationFrame((ts) => {
      window.__rafCount++;
      window.__rafTimestamps.push(ts);
      window.__tickRaf();
    });
  };
  window.__tickRaf();

  window.__trialExpired = false;
  window.__expiryEpoch = null;
  window.__twentyDayEpoch = null;
  window.__trialIntervalId = null;
  window.scheduleTrial = () => {
    if (window.__trialIntervalId !== null) {
      clearInterval(window.__trialIntervalId);
      window.__trialIntervalId = null;
    }
    const start = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const trialEndsAt = start + 30 * DAY;
    // 20-day one-shot setTimeout (fits in WebIDL 32-bit signed long max ~24.85d)
    setTimeout(() => {
      window.__twentyDayEpoch = Date.now();
    }, 20 * DAY);
    // Daily check for 30-day trial expiry (standard JS pattern beyond 24.85d)
    const id = setInterval(() => {
      if (Date.now() >= trialEndsAt) {
        clearInterval(id);
        if (window.__trialIntervalId === id) window.__trialIntervalId = null;
        window.__trialExpired = true;
        window.__expiryEpoch = Date.now();
        const b = document.getElementById('banner');
        b.textContent = 'TRIAL EXPIRED';
        b.className = 'expired';
      }
    }, DAY);
    window.__trialIntervalId = id;
  };

  window.__intervalFires = 0;
  window.startFastInterval = () => {
    window.__fastIntervalId = setInterval(() => {
      window.__intervalFires++;
    }, 10);
  };
</script>
</body>
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

test('Milestone 3 (CLOCK-01..05 & DEMO-02): isolated per-tab clock, 31d trial jump, same-renderer isolation, rAF/CSS stepping, worker inheritance & monotonic resume', async t => {
  assert.ok(DUB_BROWSER, 'DUB_BROWSER must be set');
  const fixture = await startFixtureServer(t);
  const workDir = await mkdtemp(join(tmpdir(), 'dub-m3-'));
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

  const client = new Client({ name: 'dub-m3-mcp', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client.close());

  // Open Tab 1 (target tab) and Tab 2 (same-origin control tab via native trusted
  // actor click on a window.open button so Chromium hosts both tabs in the EXACT
  // same renderer process & V8 isolate with live cross-tab script access!)
  const tab1 = await browser.open(fixture.url);
  await waitLoaded(browser, tab1.id, 'Dub Clock Fixture');

  await browser.tool(tab1.id, 'actor.click', { selector: '#open-control' });
  let tab2;
  for (let i = 0; i < 50; i++) {
    const { tabs } = await browser.tabs();
    tab2 = tabs.find(tb => tb.id !== tab1.id && tb.url.includes('/control'));
    if (tab2 && !tab2.loading) break;
    await delay(100);
  }
  assert.ok(tab2, 'Expected same-origin control tab opened via window.open');

  // Verify Tab 1 and Tab 2 actually share the same browsing context group / V8 isolate
  const sharedScriptAccess = await browser.evaluate(
    tab1.id,
    `Boolean(window.__child && window.__child.document && window.__child.document.title === 'Control Tab')`
  );
  assert.equal(sharedScriptAccess, true, 'Tab 1 and Tab 2 must share a renderer process & V8 isolate');

  // --- CLOCK-01 & DEMO-02: Freeze Tab 1 at 2026-01-01T09:00:00Z via real MCP ---
  const freezeIso = '2026-01-01T09:00:00Z';
  const freezeEpoch = Date.parse(freezeIso);
  const freezeRes = await client.callTool({
    name: 'clock_freeze',
    arguments: { tab: tab1.id, at: freezeIso },
  });
  assert.notEqual(freezeRes.isError, true, JSON.stringify(freezeRes));
  const freezeData = JSON.parse(freezeRes.content[0].text);
  assert.equal(freezeData.frozen, true);
  assert.equal(freezeData.epochMs, freezeEpoch);

  // Date.now, new Date().toISOString(), and performance.now stay frozen on Tab 1
  const t1SnapA = await browser.evaluate(
    tab1.id,
    `({ iso: new Date().toISOString(), now: Date.now(), perf: performance.now(), raf: window.__rafCount })`
  );
  assert.equal(t1SnapA.iso, '2026-01-01T09:00:00.000Z');
  assert.equal(t1SnapA.now, freezeEpoch);

  await delay(120);
  const t1SnapB = await browser.evaluate(
    tab1.id,
    `({ iso: new Date().toISOString(), now: Date.now(), perf: performance.now(), raf: window.__rafCount })`
  );
  assert.equal(t1SnapB.now, freezeEpoch, 'Date.now must remain frozen across real time');
  assert.equal(t1SnapB.perf, t1SnapA.perf, 'performance.now must remain frozen across real time');
  assert.equal(t1SnapB.raf, t1SnapA.raf, 'rAF must not advance while frozen');

  // --- CLOCK-02: Same-renderer Control Tab 2 stays completely on REAL time! ---
  const t2Before = await browser.evaluate(tab2.id, `({ now: Date.now(), perf: performance.now() })`);
  assert.ok(Math.abs(t2Before.now - Date.now()) < 5000, `Control tab Date.now must stay real, got ${t2Before.now}`);
  await browser.evaluate(tab2.id, `window.startControlTimer()`);
  await delay(140);
  const t2After = await browser.evaluate(
    tab2.id,
    `({ now: Date.now(), perf: performance.now(), fired: window.__controlTimerFired })`
  );
  assert.ok(t2After.perf > t2Before.perf + 50, 'Control tab performance.now must keep advancing in real time');
  assert.equal(t2After.fired, true, 'Control tab real setTimeout must fire normally while Tab 1 is frozen');

  // --- CLOCK-04: DedicatedWorker spawned from Tab 1 inherits frozen clock ---
  const workerSnap = await browser.evaluate(
    tab1.id,
    `new Promise((resolve, reject) => {
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { w.terminate(); resolve(e.data); };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage('go');
    })`
  );
  assert.equal(workerSnap.dateNow, freezeEpoch, 'DedicatedWorker must inherit owner tab frozen wall clock');

  // --- CLOCK-03: Exact frame stepping advances rAF + CSS animation + committed screenshot ---
  await browser.activate(tab1.id);
  const rafBeforeStep = await browser.evaluate(tab1.id, `window.__rafCount`);
  const leftBeforeStep = await browser.evaluate(tab1.id, `getComputedStyle(document.getElementById('box')).left`);
  const shotBefore = await browser.screenshot(tab1.id);

  // Step 1 frame via MCP
  const step1Res = await client.callTool({ name: 'clock_step', arguments: { tab: tab1.id, frames: 1 } });
  assert.notEqual(step1Res.isError, true, JSON.stringify(step1Res));
  assert.equal(await browser.evaluate(tab1.id, `window.__rafCount`), rafBeforeStep + 1, 'clock.step(1) must fire exactly 1 rAF');

  // Step 20 more frames (~333ms) -> box slides visibly across viewport!
  const step20Res = await client.callTool({ name: 'clock_step', arguments: { tab: tab1.id, frames: 20 } });
  assert.notEqual(step20Res.isError, true, JSON.stringify(step20Res));
  assert.equal(await browser.evaluate(tab1.id, `window.__rafCount`), rafBeforeStep + 21, 'clock.step(20) must fire exactly 20 rAFs');
  const leftAfterStep = await browser.evaluate(tab1.id, `getComputedStyle(document.getElementById('box')).left`);
  assert.ok(parseFloat(leftAfterStep) > parseFloat(leftBeforeStep) + 100, `CSS animation must advance (${leftBeforeStep} -> ${leftAfterStep})`);
  const shotAfterStep = await browser.screenshot(tab1.id);
  assert.notEqual(shotAfterStep.data, shotBefore.data, 'Committed screenshot pixels must change after stepping CSS animation');

  // --- CLOCK-01, CLOCK-05 & DEMO-02: Schedule 30-day trial expiry + fast interval, jump 31 days! ---
  await browser.evaluate(tab1.id, `window.scheduleTrial(); window.startFastInterval();`);
  const advRes = await client.callTool({ name: 'clock_advance', arguments: { tab: tab1.id, by: '31d' } });
  assert.notEqual(advRes.isError, true, JSON.stringify(advRes));
  const advData = JSON.parse(advRes.content[0].text);
  assert.equal(advData.timersCapped, true, 'Fast 10ms interval over 31d must hit bounded fire cap without hanging');
  assert.ok(advData.timersFired >= 1000, 'Expected timers to fire up to bounded cap');

  // Wait: because fast interval fired first up to 10000 fires (100s), let's clear it & verify a clean 31d trial jump too!
  await browser.evaluate(tab1.id, `clearInterval(window.__fastIntervalId);`);
  // Re-freeze at epoch, schedule ONLY the 30-day trial timer, advance 31d -> trial expires at exact 30d timestamp!
  await browser.freeze(tab1.id, freezeIso);
  await browser.evaluate(tab1.id, `window.__trialExpired = false; window.scheduleTrial();`);
  const cleanAdv = await client.callTool({ name: 'clock_advance', arguments: { tab: tab1.id, by: '31d' } });
  assert.notEqual(cleanAdv.isError, true, JSON.stringify(cleanAdv));

  const trialState = await browser.evaluate(
    tab1.id,
    `({
      expired: window.__trialExpired,
      twentyDayIso: window.__twentyDayEpoch ? new Date(window.__twentyDayEpoch).toISOString() : null,
      expiryIso: window.__expiryEpoch ? new Date(window.__expiryEpoch).toISOString() : null,
      nowIso: new Date().toISOString(),
      banner: document.getElementById('banner').textContent
    })`
  );
  assert.equal(trialState.expired, true, '30-day trial check must expire during 31d advance');
  assert.equal(trialState.twentyDayIso, '2026-01-21T09:00:00.000Z', '20-day setTimeout must observe exact virtual fire epoch');
  assert.equal(trialState.expiryIso, '2026-01-31T09:00:00.000Z', '30-day trial expiry must observe exact virtual fire epoch');
  assert.equal(trialState.nowIso, '2026-02-01T09:00:00.000Z', 'Post-advance Date must equal start + 31d');
  assert.equal(trialState.banner, 'TRIAL EXPIRED');

  const expiredShot = await browser.screenshot(tab1.id);
  assert.notEqual(expiredShot.data, shotAfterStep.data, 'Screenshot must reflect trial-expired banner');

  // --- CLOCK-04: Resume restores real wall time & NEVER moves performance.now() backwards ---
  const perfBeforeResume = await browser.evaluate(tab1.id, `performance.now()`);
  const resumeRes = await client.callTool({ name: 'clock_resume', arguments: { tab: tab1.id } });
  assert.notEqual(resumeRes.isError, true, JSON.stringify(resumeRes));
  const afterResumeA = await browser.evaluate(tab1.id, `({ now: Date.now(), perf: performance.now() })`);
  assert.ok(Math.abs(afterResumeA.now - Date.now()) < 5000, 'Date.now must return to real wall clock after resume');
  assert.ok(afterResumeA.perf >= perfBeforeResume, `performance.now must NEVER move backwards (${perfBeforeResume} -> ${afterResumeA.perf})`);
  await delay(80);
  const afterResumeB = await browser.evaluate(tab1.id, `performance.now()`);
  assert.ok(afterResumeB > afterResumeA.perf + 30, 'performance.now must advance again after resume');
});

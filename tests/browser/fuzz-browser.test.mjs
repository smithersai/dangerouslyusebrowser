import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../../dist/index.js';

const DUB_BROWSER = process.env.DUB_BROWSER;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Fuzz (real browser): randomized tabs, network rules, clock transitions, eval errors & actor edges never crash Dub', async t => {
  assert.ok(DUB_BROWSER, 'DUB_BROWSER must be set');
  const rng = mulberry32(0xfeedface);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ path: url.pathname, ok: true, marker: 'ORIGIN_MARKER' })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html><head><title>Fuzz Page</title></head>
<body>
  <button id="btn">Click</button>
  <script>window.__clicks = 0; document.getElementById('btn').onclick = () => window.__clicks++;</script>
</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const workDir = await mkdtemp(join(tmpdir(), 'dub-fuzz-browser-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const session = await launch({
    browser: DUB_BROWSER,
    socket: join(workDir, 'dub.sock'),
    profile: join(workDir, 'profile'),
    headless: process.env.DUB_HEADLESS !== '0',
  });
  t.after(() => session.close());

  const { browser } = session;

  // 1. Tab lifecycle fuzzing (open/navigate/activate/close 15 random ops)
  const openIds = [];
  for (let i = 0; i < 15; i++) {
    const roll = rng();
    if (openIds.length === 0 || roll < 0.55) {
      const tab = await browser.open(`${baseUrl}/?i=${i}`);
      openIds.push(tab.id);
    } else if (roll < 0.8) {
      const id = openIds[Math.floor(rng() * openIds.length)];
      await browser.activate(id);
    } else {
      const idx = Math.floor(rng() * openIds.length);
      const [id] = openIds.splice(idx, 1);
      await browser.close(id);
    }
  }
  const primary = await browser.open(`${baseUrl}/main`);
  await delay(300);

  // 2. Network rule engine fuzzing (40 randomized rule mutations + concurrent fetches)
  const ruleIds = [];
  const actions = ['mock', 'block', 'patch', 'redirect'];
  for (let i = 0; i < 40; i++) {
    const action = actions[Math.floor(rng() * actions.length)];
    const path = `/api/fuzz-${i % 7}`;
    if (action === 'mock') {
      const r = await browser.setRule({
        match: `*${path}*`,
        action: 'mock',
        status: [200, 201, 418, 500][Math.floor(rng() * 4)],
        body: JSON.stringify({ fuzz: i, unicode: 'λ🚀' }),
        headers: { 'content-type': 'application/json' },
      });
      ruleIds.push(r.id);
    } else if (action === 'block') {
      const r = await browser.setRule({ match: `*${path}*`, action: 'block' });
      ruleIds.push(r.id);
    } else if (action === 'patch') {
      const r = await browser.setRule({
        match: `*${path}*`,
        action: 'patch',
        replace: 'ORIGIN_MARKER',
        with: `PATCHED_${i}`,
      });
      ruleIds.push(r.id);
    } else {
      const r = await browser.setRule({
        match: `*${path}*`,
        action: 'redirect',
        url: `${baseUrl}/api/redirected-${i}`,
      });
      ruleIds.push(r.id);
    }
    if (ruleIds.length > 8 && rng() < 0.5) {
      const removeId = ruleIds.shift();
      await browser.removeRule(removeId);
    }
  }
  // Fire 10 concurrent fetches inside the page while rules are active
  const fetchResults = await browser.evaluate(
    primary.id,
    `Promise.all(Array.from({length: 10}, (_, i) =>
      fetch('/api/fuzz-' + (i % 7)).then(r => ({ status: r.status })).catch(e => ({ blocked: true, msg: String(e) }))
    ))`
  );
  assert.equal(fetchResults.length, 10);
  // Clean up all rules
  for (const id of ruleIds) await browser.removeRule(id);
  const remainingRules = await browser.rules();
  assert.equal(remainingRules.rules.length, 0);

  // 3. Clock fuzzing (random valid transitions + invalid error cases)
  await assert.rejects(browser.advance(primary.id, 1000), /CLOCK_NOT_FROZEN|freeze/i);
  await assert.rejects(browser.step(primary.id, 1), /CLOCK_NOT_FROZEN|freeze/i);

  const epochs = [
    '2026-01-01T00:00:00Z',
    '2026-06-15T12:34:56Z',
    '2030-12-31T23:59:59Z',
  ];
  for (let i = 0; i < 12; i++) {
    const op = i % 4;
    if (op === 0) {
      await browser.freeze(primary.id, epochs[Math.floor(rng() * epochs.length)]);
    } else if (op === 1) {
      await browser.advance(primary.id, Math.floor(rng() * 5000) + 1);
    } else if (op === 2) {
      await browser.step(primary.id, Math.floor(rng() * 5) + 1);
    } else {
      await browser.resume(primary.id);
    }
  }
  await browser.resume(primary.id);

  // 4. Evaluate & Actor error-path fuzzing (must return bounded errors, never crash)
  await assert.rejects(browser.evaluate(primary.id, `throw new Error('fuzz boom')`));
  await assert.rejects(browser.evaluate(primary.id, `Promise.reject(new TypeError('async boom'))`));
  await assert.rejects(browser.evaluate(primary.id, `(() => { const a = {}; a.self = a; return a; })()`));
  await assert.rejects(browser.tool(primary.id, 'actor.click', { target: '#does-not-exist-anywhere' }));
  await assert.rejects(browser.tool(primary.id, 'page.nonexistent_tool', {}));
  await assert.rejects(browser.evaluate(999999, `1 + 1`));

  // 5. Verify browser is still 100% healthy after all fuzzing!
  const info = await browser.info();
  assert.equal(info.product, 'Dub');
  assert.equal(await browser.evaluate(primary.id, `2 + 2`), 4);
  assert.equal(session.health().ok, true);
});

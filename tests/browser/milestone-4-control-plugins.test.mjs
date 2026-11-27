import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DubRuntime, createCommands, launch, listen } from '../../dist/index.js';

const DUB_BROWSER = process.env.DUB_BROWSER;

async function startFixtureServer(t) {
  const seenHeaders = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seenHeaders.push({ path: url.pathname, headers: req.headers });

    if (url.pathname === '/api/headers') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ xDub: req.headers['x-dub-injected'] ?? null, cookie: req.headers.cookie ?? '' })
      );
      return;
    }
    if (url.pathname === '/api/dynamic') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ source: 'origin', role: 'guest' }));
      return;
    }
    if (url.pathname === '/api/secret') {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'PAYWALL', plan: 'free' }));
      return;
    }
    if (url.pathname === '/download.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="dub-report.txt"',
      }).end('hello from dub download');
      return;
    }
    if (url.pathname === '/subframe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><title>Subframe</title><div id="sub">inside-iframe</div>`
      );
      return;
    }
    if (url.pathname === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><title>Page Two</title><h1>Second Page</h1>`
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Milestone 4 Fixture</title></head>
<body>
  <h1>Dub Milestone 4</h1>
  <button id="main-btn">Main Button</button>
  <button id="hover-btn">Hover Me</button>
  <input id="key-input" type="text" placeholder="Type or Esc" />
  <a id="dl-link" href="/download.txt">Download File</a>
  <div id="shadow-host"></div>
  <div id="delayed-box"></div>
  <iframe id="child" src="/subframe" width="200" height="60"></iframe>
  <script>
    window.__initRanBeforePage = Boolean(window.__dubPreloadTag);
    console.log('dub-console-hello');
    console.error('dub-console-boom');

    window.__clicks = 0;
    window.__hovered = false;
    window.__lastKey = '';
    document.getElementById('main-btn').addEventListener('click', () => { window.__clicks++; });
    document.getElementById('hover-btn').addEventListener('mouseenter', () => { window.__hovered = true; });
    window.addEventListener('keydown', (e) => { window.__lastKey = e.key; });

    // Open Shadow DOM button
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    const sbtn = document.createElement('button');
    sbtn.id = 'shadow-btn';
    sbtn.textContent = 'Shadow Action';
    sbtn.addEventListener('click', () => { window.__shadowClicked = true; });
    sr.appendChild(sbtn);

    // Delayed DOM node for page.wait
    setTimeout(() => {
      const el = document.createElement('div');
      el.id = 'ready-badge';
      el.textContent = 'READY_NOW';
      document.getElementById('delayed-box').appendChild(el);
    }, 250);
  </script>
</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(r => server.close(r));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seenHeaders };
}

test('Milestone 4 real compiled Dub browser: observation, shadow DOM, frames, input, dialogs, downloads, cookies, init scripts, live TS plugins, Smithers code mode, Jev & BYO agent rewrite triggers', { skip: !DUB_BROWSER }, async t => {
  const fx = await startFixtureServer(t);
  const work = await mkdtemp(join(tmpdir(), 'dub-m4-'));
  const dlDir = join(work, 'downloads');
  const socket = join(work, 'dub.sock');
  const profile = join(work, 'profile');

  const session = await launch({
    browser: DUB_BROWSER,
    socket,
    profile,
    headless: process.env.DUB_HEADLESS !== '0',
  });
  const agentTurns = [];
  const rt = new DubRuntime(session.browser, {
    jev: {
      script: req => ({
        isPaywall: { probability: String(req.state.body ?? '').includes('PAYWALL') ? 0.99 : 0.01 },
      }),
    },
    agent: {
      kind: 'custom',
      handler: async turn => {
        agentTurns.push(turn);
        // Agent replies with a Smithers code-mode TypeScript cell that computes the rewrite!
        return {
          code: `
            const orig: { error?: string } = JSON.parse(event.body || '{}');
            ctx.done({
              action: 'modify',
              status: 200,
              headers: { 'content-type': 'application/json', 'x-rewritten-by': 'dub-agent-cell' },
              body: JSON.stringify({ unlocked: true, replaced: orig.error, turn: ${JSON.stringify(turn.turnId)} }),
            });
          `,
        };
      },
    },
  });

  const cli = createCommands(session.browser, { methods: session.info.methods, tools: session.info.tools }, rt);
  const http = await listen(cli.fetch, { host: '127.0.0.1', port: 0, health: () => session.health() });
  const client = new Client({ name: 'dub-m4-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`));
  await client.connect(transport);
  t.after(async () => {
    await transport.close().catch(() => {});
    await http.close().catch(() => {});
    await rt.close().catch(() => {});
    await session.close().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  });

  const { browser } = session;

  // 1. Add a pre-document TypeScript init script (runs before page JS!)
  const initRes = await browser.addScript({
    match: `${fx.baseUrl}/*`,
    source: `const tag: string = 'preloaded-ok'; (window as any).__dubPreloadTag = tag;`.replace(': string', '').replace(' as any', ''),
    world: 'main',
  });
  assert.ok(initRes.id);

  // 2. Open tab with waitUntil='load' (no manual polling!)
  const tab = await browser.open(`${fx.baseUrl}/`, { waitUntil: 'load' });
  assert.equal(tab.title, 'Milestone 4 Fixture');

  // Verify init script ran BEFORE inline page <script>
  assert.equal(await browser.evaluate(tab.id, 'window.__initRanBeforePage'), true);

  // Verify isolated world evaluation does not leak into main world
  await browser.evaluate(tab.id, 'window.__isolatedSecret = 777', { world: 'isolated' });
  assert.equal(await browser.evaluate(tab.id, 'window.__isolatedSecret', { world: 'isolated' }), 777);
  assert.equal(await browser.evaluate(tab.id, 'typeof window.__isolatedSecret', { world: 'main' }), 'undefined');

  // 3. Frames list + subframe evaluation
  const { frames } = await browser.frames(tab.id);
  const sub = frames.find(f => !f.isMainFrame && f.url.includes('/subframe'));
  assert.ok(sub, `Expected subframe in ${JSON.stringify(frames)}`);
  assert.equal(await browser.evaluate(tab.id, `document.getElementById('sub').textContent`, { frameId: sub.frameId }), 'inside-iframe');

  // 4. Snapshot (including Shadow DOM + real Blink nodeIds) & native actor.click by nodeId + Shadow DOM
  const snap = await browser.snapshot(tab.id);
  const mainBtn = snap.nodes.find(n => n.selector === '#main-btn');
  const shadowBtn = snap.nodes.find(n => n.selector === '#shadow-btn' && n.inShadow);
  assert.ok(mainBtn?.nodeId, `Expected mainBtn nodeId in ${JSON.stringify(snap.nodes)}`);
  assert.ok(shadowBtn?.nodeId, `Expected shadowBtn in open Shadow DOM: ${JSON.stringify(snap.nodes)}`);

  await browser.tool(tab.id, 'actor.click', { nodeId: mainBtn.nodeId });
  assert.equal(await browser.evaluate(tab.id, 'window.__clicks'), 1);

  await browser.tool(tab.id, 'actor.click', { selector: '#shadow-btn' });
  assert.equal(await browser.evaluate(tab.id, 'window.__shadowClicked'), true);

  // 5. Native actor.hover and actor.key
  await browser.tool(tab.id, 'actor.hover', { selector: '#hover-btn' });
  assert.equal(await browser.evaluate(tab.id, 'window.__hovered'), true);

  await browser.tool(tab.id, 'actor.key', { key: 'Escape' });
  await delay(80);
  assert.equal(await browser.evaluate(tab.id, 'window.__lastKey'), 'Escape');

  // 6. Console capture + native page.wait
  const cons = await browser.console(tab.id);
  assert.ok(cons.entries.some(e => e.message.includes('dub-console-hello')));
  assert.ok(cons.entries.some(e => e.level === 'error' && e.message.includes('dub-console-boom')));

  const waited = await browser.wait(tab.id, { selector: '#ready-badge', state: 'visible', timeoutMs: 5000 });
  assert.equal(waited.ok, true);

  // 7. Navigation history (navigate -> back -> forward), viewport, JPEG screenshot, emulation
  await browser.navigate(tab.id, `${fx.baseUrl}/page2`, { waitUntil: 'load' });
  assert.equal((await browser.evaluate(tab.id, 'document.title')), 'Page Two');
  await browser.back(tab.id, { waitUntil: 'load' });
  assert.equal((await browser.evaluate(tab.id, 'document.title')), 'Milestone 4 Fixture');

  const jpg = await browser.screenshot(tab.id, { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 200, height: 150 } });
  assert.equal(jpg.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(jpg.data, 'base64')[0], 0xff);

  await browser.emulate(tab.id, { colorScheme: 'dark', randomSeed: 12345 });
  assert.equal(await browser.evaluate(tab.id, `matchMedia('(prefers-color-scheme: dark)').matches`), true);
  const r1 = await browser.evaluate(tab.id, 'Math.random()');
  await browser.emulate(tab.id, { randomSeed: 12345 });
  const r2 = await browser.evaluate(tab.id, 'Math.random()');
  assert.equal(r1, r2, 'Seeded Math.random() must be deterministic');

  // 8. Cookies (HttpOnly) + ephemeral OTR tab isolation
  await browser.setCookie({ url: `${fx.baseUrl}/`, name: 'dub_secret', value: 'top-secret', httpOnly: true });
  const cookiesList = await browser.cookies(`${fx.baseUrl}/`);
  assert.ok(cookiesList.cookies.some(c => c.name === 'dub_secret' && c.httpOnly === true));

  const mainHdrs = await browser.evaluate(tab.id, `fetch('/api/headers').then(r => r.json())`);
  assert.match(mainHdrs.cookie, /dub_secret=top-secret/);

  const otrTab = await browser.open(`${fx.baseUrl}/`, { waitUntil: 'load', ephemeral: true });
  assert.equal(otrTab.ephemeral, true);
  const otrHdrs = await browser.evaluate(otrTab.id, `fetch('/api/headers').then(r => r.json())`);
  assert.equal(otrHdrs.cookie, '', 'Ephemeral OTR tab must NOT see persistent profile cookies');
  await browser.close(otrTab.id);

  // 9. Dialog auto-handling (does not hang!)
  await browser.dialogPolicy({ mode: 'auto_accept', promptText: 'dub-prompt-answer' });
  const promptAns = await browser.evaluate(tab.id, `prompt('Who?')`);
  assert.equal(promptAns, 'dub-prompt-answer');

  // 10. Downloads tracking
  await browser.configureDownloads(dlDir);
  const dlWait = browser.waitDownload();
  await browser.tool(tab.id, 'actor.click', { selector: '#dl-link' });
  const dlDone = await dlWait;
  assert.equal(dlDone.state, 'complete');
  assert.match(String(dlDone.filename), /dub-report/);

  // 11. Network modify (request/response headers) + body capture & inspect
  await browser.networkConfig({ captureBodies: true, maxBodyBytes: 65536 });
  await browser.setRule({
    match: '*/api/headers',
    action: 'modify',
    setRequestHeaders: { 'X-Dub-Injected': 'from-network-seam' },
    setResponseHeaders: { 'X-Dub-Resp': 'mutated' },
  });
  const modRes = await browser.evaluate(tab.id, `fetch('/api/headers').then(async r => ({ h: r.headers.get('x-dub-resp'), body: await r.json() }))`);
  assert.equal(modRes.h, 'mutated');
  assert.equal(modRes.body.xDub, 'from-network-seam');
  const netLog = await browser.networkLog('/api/headers', 0);
  const lastSeq = netLog.entries[netLog.entries.length - 1].seq;
  const inspected = await browser.inspectNetwork(lastSeq);
  assert.match(String(inspected.responseBody), /from-network-seam/);

  // 12. Hot-loadable TypeScript plugin: live net.handle callback + exposeFunction + synthetic WebMCP!
  const pluginFile = join(work, 'live-plugin.ts');
  await writeFile(
    pluginFile,
    `
    export default {
      name: 'live-m4',
      async setup(dub: any) {
        await dub.exposeFunction('hostMultiply', (a: number, b: number) => a * b);
        await dub.net.handle('*/api/dynamic', async (req: any) => {
          return { action: 'mock', status: 200, json: { source: 'ts-plugin', role: 'admin', url: req.url } };
        });
        dub.pageTool({
          match: '*127.0.0.1*',
          name: 'synth_sum',
          description: 'Synthetic WebMCP tool',
          run: async (input: { a: number; b: number }) => ({ sum: input.a + input.b }),
        });
      },
    };
    `,
    'utf8'
  );
  await rt.plugins.loadFromFile(pluginFile);

  const dynData = await browser.evaluate(tab.id, `fetch('/api/dynamic').then(r => r.json())`);
  assert.equal(dynData.source, 'ts-plugin');
  assert.equal(dynData.role, 'admin');

  const hostRes = await browser.evaluate(tab.id, `window.hostMultiply(6, 7)`);
  assert.equal(hostRes, 42);

  // 13. LIVE REACTIVE TRIGGER: real Chromium response -> Jev detects PAYWALL -> triggers new BYO agent turn -> agent emits Smithers QuickJS TS cell -> rewrites live response before page sees it!
  await rt.triggers.register({
    on: 'net.response',
    match: '*/api/secret',
    mode: 'jev',
    questions: { isPaywall: { type: 'boolean', instructions: 'Is this a paywall response?' } },
    jevRoutes: { true: 'agent', false: { action: 'continue' } },
    prompt: 'Unlock the paywalled response',
  });
  const unlocked = await browser.evaluate(tab.id, `fetch('/api/secret').then(async r => ({ status: r.status, hdr: r.headers.get('x-rewritten-by'), body: await r.json() }))`);
  assert.equal(agentTurns.length, 1);
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.hdr, 'dub-agent-cell');
  assert.equal(unlocked.body.unlocked, true);
  assert.equal(unlocked.body.replaced, 'PAYWALL');

  // 14. Smithers QuickJS code mode via MCP `exec` driving the real Chromium tab!
  const execRes = await client.callTool({
    name: 'exec',
    arguments: {
      code: `
        const snap = await ctx.call("dub.page.snapshot", { tab: ${tab.id} });
        ctx.done({ title: snap.title, nodeCount: snap.nodes.length });
      `,
    },
  });
  assert.notEqual(execRes.isError, true, JSON.stringify(execRes));
  const execData = JSON.parse(execRes.content[0].text);
  assert.equal(execData.ok, true);
  assert.equal(execData.output.title, 'Milestone 4 Fixture');
  assert.ok(execData.output.nodeCount >= 3);

  // 15. Trace HAR 1.2 export
  const trace = await browser.exportTrace(tab.id, { includeScreenshot: false });
  assert.equal(trace.har.log.version, '1.2');
  assert.ok(trace.har.log.entries.length >= 2);
});

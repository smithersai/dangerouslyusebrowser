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
import { createCommands, launch, listen } from '../../dist/index.js';

const DUB_BROWSER = process.env.DUB_BROWSER;

async function startFixtureServer(t) {
  const events = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pong: 42 }));
      return;
    }
    if (url.pathname === '/api/event' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname === '/login') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'dub_session=alice-123; Path=/; Max-Age=3600; SameSite=Lax',
      }).end(`<!doctype html><title>Signed In</title><script>
        localStorage.setItem('dub_user', 'alice');
      </script><div id="who">alice</div>`);
      return;
    }
    if (url.pathname === '/whoami') {
      const cookie = req.headers.cookie || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
        <title>WhoAmI</title>
        <div id="cookie">${cookie}</div>
        <div id="ls"></div>
        <script>document.getElementById('ls').textContent = localStorage.getItem('dub_user') || 'none';</script>`);
      return;
    }
    if (url.pathname === '/iframe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
        <title>Subframe</title>
        <script>
          if (document.modelContext) {
            document.modelContext.registerTool({
              name: 'shared_tool',
              description: 'Subframe version of shared_tool',
              inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
              async execute(args) { return JSON.stringify({ where: 'iframe', v: args.v }); }
            });
          }
        </script>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dub Milestone 1 Fixture</title>
<style>
  body { margin: 20px; font-family: sans-serif; height: 2200px; }
  button, input, select { display: block; margin: 12px 0; padding: 8px; font-size: 16px; }
</style>
</head>
<body>
  <button id="approve">Approve</button>
  <input id="memo" type="text" placeholder="Memo" />
  <select id="role">
    <option value="viewer">Viewer</option>
    <option value="admin">Admin</option>
  </select>
  <input id="upload" type="file" />
  <div id="upload-result"></div>
  <iframe src="/iframe" width="200" height="60"></iframe>
  <script>
    document.getElementById('approve').addEventListener('click', (e) => {
      fetch('/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'approve', isTrusted: e.isTrusted }),
      });
    });
    document.getElementById('upload').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      const text = f ? await f.text() : '';
      document.getElementById('upload-result').textContent = (f ? f.name : '') + ':' + text;
      fetch('/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'upload', name: f ? f.name : '', content: text }),
      });
    });

    // Register WebMCP tools if supported
    window.__webmcpSupported = Boolean(document.modelContext);
    if (document.modelContext) {
      document.modelContext.registerTool({
        name: 'submit_expense',
        title: 'Submit Expense',
        description: 'Submits an expense report',
        inputSchema: {
          type: 'object',
          required: ['amount', 'memo'],
          properties: { amount: { type: 'number' }, memo: { type: 'string' } }
        },
        async execute(args) {
          await fetch('/api/event', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'expense', args }),
          });
          return JSON.stringify({ accepted: true, amount: args.amount, memo: args.memo });
        }
      });
      window.__failingAc = new AbortController();
      document.modelContext.registerTool({
        name: 'failing_tool',
        description: 'Always rejects',
        inputSchema: { type: 'object', properties: {} },
        async execute() { throw new Error('expense limit exceeded'); }
      }, { signal: window.__failingAc.signal });
      document.modelContext.registerTool({
        name: 'shared_tool',
        description: 'Main frame version of shared_tool',
        inputSchema: { type: 'object', properties: { v: { type: 'string' } } },
        async execute(args) { return JSON.stringify({ where: 'main', v: args.v }); }
      });
    }
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
  return { url: `http://127.0.0.1:${server.address().port}`, events };
}

async function waitLoaded(browser, tabId, expectedTitle) {
  for (let i = 0; i < 60; i++) {
    const { tabs } = await browser.tabs();
    const tab = tabs.find(t => t.id === tabId);
    if (tab && !tab.loading && (!expectedTitle || tab.title === expectedTitle)) return tab;
    await delay(100);
  }
  throw new Error(`Timed out waiting for tab ${tabId} title=${expectedTitle}`);
}

test('Milestone 1: JS-01 eval, RENDER-01 screenshot, ACTOR-01..03, WEBMCP-01..03, PROFILE-01..02', async t => {
  assert.ok(DUB_BROWSER, 'DUB_BROWSER must be set');
  const fixture = await startFixtureServer(t);
  const workDir = await mkdtemp(join(tmpdir(), 'dub-m1-'));
  const socket = join(workDir, 'sock', 'dub.sock');
  const profile = join(workDir, 'profile');
  const uploadPath = join(workDir, 'receipt.txt');
  await writeFile(uploadPath, 'lunch-receipt-42.10\n', 'utf8');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const session = await launch({
    browser: DUB_BROWSER,
    socket,
    profile,
    headless: process.env.DUB_HEADLESS !== '0',
  });
  t.after(() => session.close());

  const { browser } = session;
  const tab = await browser.open(fixture.url);
  await waitLoaded(browser, tab.id, 'Dub Milestone 1 Fixture');
  await delay(200);

  // --- JS-01: Promise-aware evaluate + errors + non-serializable ---
  assert.equal(await browser.evaluate(tab.id, '21 + 21'), 42);
  const fetched = await browser.evaluate(tab.id, `fetch('/api/ping').then(r => r.json())`);
  assert.deepEqual(fetched, { pong: 42 });
  await assert.rejects(browser.evaluate(tab.id, `(() => { throw new Error('sync boom'); })()`), /sync boom/);
  await assert.rejects(browser.evaluate(tab.id, `Promise.reject(new Error('async boom'))`), /async boom/);
  await assert.rejects(browser.evaluate(tab.id, `const c = {}; c.self = c; c`), /circular|serializable/i);

  // --- RENDER-01: Real PNG screenshot ---
  const shot = await browser.screenshot(tab.id);
  assert.equal(shot.mimeType, 'image/png');
  const png = Buffer.from(shot.data, 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.ok((shot.width ?? 0) > 0 && (shot.height ?? 0) > 0);

  // --- ACTOR-01 & ACTOR-02: Native click by target text, type, select, scroll, missing target ---
  await browser.tool(tab.id, 'actor.click', { target: 'Approve' });
  for (let i = 0; i < 30 && !fixture.events.some(e => e.type === 'approve'); i++) await delay(100);
  const approveEvent = fixture.events.find(e => e.type === 'approve');
  assert.ok(approveEvent && approveEvent.isTrusted === true, 'actor.click by target text must be trusted');

  await browser.tool(tab.id, 'actor.type', { selector: '#memo', text: 'team lunch' });
  assert.equal(await browser.evaluate(tab.id, `document.getElementById('memo').value`), 'team lunch');

  await browser.tool(tab.id, 'actor.select', { selector: '#role', value: 'admin' });
  assert.equal(await browser.evaluate(tab.id, `document.getElementById('role').value`), 'admin');

  await browser.tool(tab.id, 'actor.scroll', { direction: 'down', distance: 400 });
  assert.ok((await browser.evaluate(tab.id, 'window.scrollY')) > 0);

  await assert.rejects(browser.tool(tab.id, 'actor.click', { target: 'Does Not Exist' }), /Target not found/i);

  // --- ACTOR-03: Native file upload ---
  await browser.tool(tab.id, 'actor.upload_file', { selector: '#upload', path: uploadPath });
  for (let i = 0; i < 30 && !fixture.events.some(e => e.type === 'upload'); i++) await delay(100);
  const uploadEvent = fixture.events.find(e => e.type === 'upload');
  assert.ok(uploadEvent, 'Upload change event must fire');
  assert.equal(uploadEvent.name, 'receipt.txt');
  assert.equal(uploadEvent.content, 'lunch-receipt-42.10\n');

  // --- WEBMCP-01..02 & DEMO-03: Live page-tool catalog + invocation + duplicate frames + error ---
  assert.equal(await browser.evaluate(tab.id, 'window.__webmcpSupported'), true, 'WebMCP navigator.modelContext must be enabled');
  const { tools } = await browser.tools(tab.id);
  const expenseTool = tools.find(tool => tool.name === 'page.submit_expense');
  assert.ok(expenseTool, `Expected page.submit_expense in tools.list, got: ${JSON.stringify(tools.map(x => x.name))}`);
  assert.equal(expenseTool.description, 'Submits an expense report');
  assert.ok(expenseTool.frameId);

  // Invoke through real MCP client!
  const server = await listen(
    createCommands(browser, { methods: session.info.methods, tools: session.info.tools }).fetch,
    { port: 0, health: () => session.health() }
  );
  t.after(() => server.close());
  const client = new Client({ name: 'dub-m1-mcp', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client.close());

  const mcpCall = await client.callTool({
    name: 'tools_call',
    arguments: { tab: tab.id, name: 'page.submit_expense', input: JSON.stringify({ amount: 42.1, memo: 'team lunch' }) },
  });
  assert.notEqual(mcpCall.isError, true, JSON.stringify(mcpCall));
  const expenseResult = JSON.parse(mcpCall.content[0].text);
  assert.deepEqual(expenseResult.output, { accepted: true, amount: 42.1, memo: 'team lunch' });
  assert.ok(fixture.events.some(e => e.type === 'expense' && e.args.amount === 42.1));

  // Duplicate tool across main frame & iframe must require frameId, then succeed per frame
  const sharedTools = tools.filter(tool => tool.name === 'page.shared_tool');
  assert.equal(sharedTools.length, 2, 'Expected shared_tool in both main frame and iframe');
  await assert.rejects(browser.tool(tab.id, 'page.shared_tool', { v: 'hi' }), /Multiple frames/);
  const iframeTool = sharedTools.find(tool => !tool.isMainFrame);
  const iframeRes = await browser.tool(tab.id, 'page.shared_tool', { frameId: iframeTool.frameId, v: 'sub' });
  assert.deepEqual(iframeRes.output, { where: 'iframe', v: 'sub' });

  // Failing page tool propagates error cleanly
  await assert.rejects(
    browser.tool(tab.id, 'page.failing_tool', {}),
    err => err && err.code === 'TOOL_FAILED'
  );

  // Unregistering a tool via AbortSignal removes it from live tools.list
  await browser.evaluate(tab.id, `window.__failingAc.abort()`);
  const afterUnreg = (await browser.tools(tab.id)).tools;
  assert.ok(!afterUnreg.some(tool => tool.name === 'page.failing_tool'));

  // --- PROFILE-01 & PROFILE-02: Persistence across restart + scoped storage clear ---
  await browser.navigate(tab.id, `${fixture.url}/login`);
  await waitLoaded(browser, tab.id, 'Signed In');
  await delay(300);
  await session.close();

  // Restart Dub with the same persistent profile
  const session2 = await launch({
    browser: DUB_BROWSER,
    socket,
    profile,
    headless: process.env.DUB_HEADLESS !== '0',
  });
  t.after(() => session2.close());
  const pInfo = await session2.browser.profileInfo();
  assert.ok(pInfo.path.includes(profile));
  const checkTab = await session2.browser.open(`${fixture.url}/whoami`);
  await waitLoaded(session2.browser, checkTab.id, 'WhoAmI');
  assert.match(await session2.browser.evaluate(checkTab.id, `document.getElementById('cookie').textContent`), /dub_session=alice-123/);
  assert.equal(await session2.browser.evaluate(checkTab.id, `document.getElementById('ls').textContent`), 'alice');

  // Scoped storage clear wipes cookies & localStorage
  const cleared = await session2.browser.profileClear(['cookies', 'localStorage']);
  assert.equal(cleared.cleared, true);
  await session2.browser.navigate(checkTab.id, `${fixture.url}/whoami`);
  await waitLoaded(session2.browser, checkTab.id, 'WhoAmI');
  assert.equal(await session2.browser.evaluate(checkTab.id, `document.getElementById('cookie').textContent`), '');
  assert.equal(await session2.browser.evaluate(checkTab.id, `document.getElementById('ls').textContent`), 'none');
});

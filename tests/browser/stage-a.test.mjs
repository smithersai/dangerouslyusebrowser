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
const EXPECTED_REVISION = '0e331aaf43bf5e1ffe16e65140de2d925c18f0a2';

async function startFixtureServer(t) {
  const clicks = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/click-report' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      clicks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"recorded":true}');
      return;
    }
    if (url.pathname === '/second') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        '<!doctype html><title>Dub Second Page</title><h1>Second</h1>'
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dub Stage A Fixture</title>
<style>html,body{margin:0;padding:0}#target{position:fixed;left:40px;top:40px;width:160px;height:60px;font-size:18px}</style>
</head>
<body>
<button id="target">Click Me</button>
<div id="status">idle</div>
<script>
let count = 0;
document.getElementById('target').addEventListener('click', (e) => {
  count++;
  document.getElementById('status').textContent = 'clicked:' + count + ':trusted=' + e.isTrusted;
  fetch('/click-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count, isTrusted: e.isTrusted, x: e.clientX, y: e.clientY }),
  });
});
</script>
</body>
</html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}`, clicks };
}

function parseToolText(result) {
  const item = result.content?.find(c => c.type === 'text');
  assert.ok(item && 'text' in item, `Expected text content, got: ${JSON.stringify(result)}`);
  return JSON.parse(item.text);
}

test('Stage A: compiled Dub fork -> N-API -> incur MCP -> tabs + native trusted actor click + keepalive', async t => {
  assert.ok(
    DUB_BROWSER,
    'DUB_BROWSER must point to the compiled Dub Chromium binary. Real-browser gates never pass without a compiled fork.'
  );

  const fixture = await startFixtureServer(t);
  const workDir = await mkdtemp(join(tmpdir(), 'dub-stage-a-'));
  const socketDir = join(workDir, 'sock');
  const socket = join(socketDir, 'dub.sock');
  const profile = join(workDir, 'profile');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const session = await launch({
    browser: DUB_BROWSER,
    socket,
    profile,
    headless: process.env.DUB_HEADLESS !== '0',
  });
  t.after(() => session.close());

  assert.equal(session.info.product, 'Dub');
  assert.equal(session.info.protocol, 1);
  assert.equal(session.info.revision, EXPECTED_REVISION);
  assert.ok(session.info.buildId && session.info.buildId.length > 0, 'Expected generated buildId');
  assert.ok(session.info.instanceId && session.info.instanceId.length > 0, 'Expected instanceId');
  assert.ok(session.info.profile.includes(profile), `Expected profile path to match ${profile}, got ${session.info.profile}`);

  // Conflicting live socket launch must fail cleanly
  await assert.rejects(
    launch({ browser: DUB_BROWSER, socket, profile: join(workDir, 'profile2'), headless: true }),
    /already running/
  );

  const server = await listen(
    createCommands(session.browser, { methods: session.info.methods, tools: session.info.tools }).fetch,
    { port: 0, health: () => session.health() }
  );
  t.after(() => server.close());

  assert.equal((await fetch(`${server.url}/health`)).status, 200);

  const client1 = new Client({ name: 'dub-stage-a-1', version: '1' });
  await client1.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client1.close());

  const client2 = new Client({ name: 'dub-stage-a-2', version: '1' });
  await client2.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  t.after(() => client2.close());

  const listed = new Set((await client1.listTools()).tools.map(tool => tool.name));
  for (const required of ['status', 'tabs_list', 'tabs_open', 'tabs_close', 'tabs_activate', 'tabs_navigate', 'tools_call']) {
    assert.ok(listed.has(required), `Missing required Stage A MCP tool: ${required}`);
  }
  assert.ok(!listed.has('clock_freeze'), 'Unimplemented clock commands must stay unadvertised in Stage A');
  assert.ok(!listed.has('net_mock'), 'Unimplemented net commands must stay unadvertised in Stage A');

  // Open fixture page via client1, observe it from client2
  const openedRes = await client1.callTool({ name: 'tabs_open', arguments: { url: fixture.url } });
  assert.notEqual(openedRes.isError, true, JSON.stringify(openedRes));
  const opened = parseToolText(openedRes);
  assert.ok(Number.isInteger(opened.id) && opened.id > 0);

  // Wait for navigation/title to settle
  let matched;
  for (let i = 0; i < 50; i++) {
    const listRes = await client2.callTool({ name: 'tabs_list', arguments: {} });
    const list = parseToolText(listRes);
    matched = list.tabs.find(tab => tab.id === opened.id);
    if (matched && !matched.loading && matched.title === 'Dub Stage A Fixture') break;
    await delay(100);
  }
  assert.ok(matched, 'Opened tab must appear in client2 tabs_list');
  assert.equal(matched.title, 'Dub Stage A Fixture');

  // Click fixed-position button at (120, 70) through native Chromium actor path
  const clickRes = await client1.callTool({
    name: 'tools_call',
    arguments: { tab: opened.id, name: 'actor.click', input: JSON.stringify({ x: 120, y: 70 }) },
  });
  assert.notEqual(clickRes.isError, true, `Native actor.click failed: ${JSON.stringify(clickRes)}`);

  for (let i = 0; i < 30 && fixture.clicks.length === 0; i++) await delay(100);
  assert.equal(fixture.clicks.length, 1, 'Local fixture server must observe the native actor click');
  assert.equal(fixture.clicks[0].isTrusted, true, 'Native actor click must produce a trusted DOM event');
  assert.equal(fixture.clicks[0].count, 1);

  // Navigate to second page and verify state update
  const navRes = await client1.callTool({
    name: 'tabs_navigate',
    arguments: { tab: opened.id, url: `${fixture.url}/second` },
  });
  assert.notEqual(navRes.isError, true, JSON.stringify(navRes));
  let navigated;
  for (let i = 0; i < 50; i++) {
    const list = parseToolText(await client1.callTool({ name: 'tabs_list', arguments: {} }));
    navigated = list.tabs.find(tab => tab.id === opened.id);
    if (navigated && !navigated.loading && navigated.title === 'Dub Second Page') break;
    await delay(100);
  }
  assert.equal(navigated?.title, 'Dub Second Page');

  // Close all tabs -> keepalive must keep Dub alive -> reopen a new tab
  const beforeClose = parseToolText(await client1.callTool({ name: 'tabs_list', arguments: {} }));
  for (const tab of beforeClose.tabs) {
    const c = await client1.callTool({ name: 'tabs_close', arguments: { tab: tab.id } });
    assert.notEqual(c.isError, true, JSON.stringify(c));
  }
  await delay(300);
  assert.equal((await fetch(`${server.url}/health`)).status, 200, 'Closing the last window must keep Dub alive');
  const reopened = parseToolText(await client2.callTool({ name: 'tabs_open', arguments: { url: fixture.url } }));
  assert.ok(Number.isInteger(reopened.id) && reopened.id > 0, 'Must reopen a window/tab after closing last window');

  // Clean shutdown transitions health to unhealthy
  await session.close();
  assert.equal((await fetch(`${server.url}/health`)).status, 503);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Browser, NativeBridge, createCommands, listen, duration } from '../dist/index.js';

async function bridgeFixture(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'dub-mcp-'));
  const socket = join(dir, 's');
  const calls = []; const sockets = new Set();
  const server = createServer(s => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    let data = Buffer.alloc(0);
    s.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4 || data.length !== data.readUInt32BE(0) + 4) return;
      const request = JSON.parse(data.subarray(4)); calls.push(request);
      const reply = respond(request);
      const body = Buffer.from(JSON.stringify({ protocol: 1, id: request.id, ...reply }));
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length); s.end(Buffer.concat([head, body]));
    });
  });
  server.listen(socket); await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { browser: new Browser(new NativeBridge(socket)), calls };
}
test('real MCP client -> incur -> typed SDK -> compiled N-API -> protocol fixture', async t => {
  const f = await bridgeFixture(t, req => req.method === 'tabs.list' ? { result: { tabs: [{ id: 7, title: 'Fixture', url: 'https://example.test/', active: true, loading: false }] } } : { result: req.params });
  const server = await listen(createCommands(f.browser).fetch, { port: 0 }); t.after(() => server.close());
  const client = new Client({ name: 'dub-integration', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`))); t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'tabs_list'));
  assert.ok(tools.some(tool => tool.name === 'clock_advance'));
  assert.ok(!tools.some(tool => tool.name === 'serve'));
  const tabs = await client.callTool({ name: 'tabs_list', arguments: {} });
  assert.notEqual(tabs.isError, true);
  assert.match(JSON.stringify(tabs), /example\.test/);
  const advance = await client.callTool({ name: 'clock_advance', arguments: { tab: 7, by: '31d' } });
  assert.notEqual(advance.isError, true);
  assert.deepEqual(f.calls.at(-1).params, { tab: 7, milliseconds: 2678400000 });
  const call = await client.callTool({ name: 'tools_call', arguments: { name: 'page.submit_expense', tab: 7, input: '{"amount":42.1}' } });
  assert.notEqual(call.isError, true, JSON.stringify(call));
  assert.deepEqual(f.calls.at(-1).params, { tab: 7, name: 'page.submit_expense', input: { amount: 42.1 } });
  const count = f.calls.length;
  const bad = await client.callTool({ name: 'clock_advance', arguments: { tab: -1, by: '1s' } });
  assert.equal(bad.isError, true); assert.equal(f.calls.length, count);
});
test('native browser failures remain errors through MCP', async t => {
  const f = await bridgeFixture(t, () => ({ error: { code: 'TAB_NOT_FOUND', message: 'Tab 999 does not exist' } }));
  const server = await listen(createCommands(f.browser).fetch, { port: 0 }); t.after(() => server.close());
  const client = new Client({ name: 'dub-errors', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`))); t.after(() => client.close());
  const result = await client.callTool({ name: 'tabs_close', arguments: { tab: 999 } });
  assert.equal(result.isError, true); assert.match(JSON.stringify(result), /Tab 999/);
});
test('SDK rejects mismatched IDs, malformed envelopes and non-Dub identities', async t => {
  for (const reply of [{ id: 'wrong', result: {} }, { result: {}, error: { code: 'E', message: 'bad' } }, { protocol: 2, result: {} }, { result: { product: 'Chrome', protocol: 1 } }]) {
    const f = await bridgeFixture(t, () => reply);
    await assert.rejects(f.browser.info());
  }
});
test('HTTP boundary rejects foreign origins, forged hosts and invalid tokens', async t => {
  let calls = 0;
  const token = 'this-is-a-test-token-long-enough';
  const server = await listen(async () => { calls++; return Response.json({ ok: true }); }, { port: 0, token }); t.after(() => server.close());
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal((await fetch(server.url, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(server.url, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    httpRequest(server.url, { headers: { authorization: `Bearer ${token}`, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal(calls, 1);
  await assert.rejects(listen(async () => new Response(), { host: '0.0.0.0', port: 0 }), /require DUB_TOKEN/);
});
test('durations preserve milliseconds and reject ambiguous inputs', () => {
  assert.equal(duration('31d'), 2678400000); assert.equal(duration('1.5s'), 1500);
  for (const bad of ['1', '0ms', '-1s', '1year', '0.1ms', 'Infinitys', '999999999999999d']) assert.throws(() => duration(bad));
});
test('capability handshake gates MCP tool catalog and /health reflects session state', async t => {
  const f = await bridgeFixture(t, req => ({ result: { ok: true, timeoutMs: req.timeoutMs } }));
  let ok = true;
  const server = await listen(
    createCommands(f.browser, { methods: ['browser.info', 'tabs.list', 'tools.call'] }).fetch,
    { port: 0, health: () => ({ ok, state: ok ? 'ready' : 'failed' }) }
  );
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/health`)).status, 200);
  ok = false;
  const unhealthy = await fetch(`${server.url}/health`);
  assert.equal(unhealthy.status, 503);
  assert.match(await unhealthy.text(), /"state":"failed"/);

  const client = new Client({ name: 'dub-caps', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`))); t.after(() => client.close());
  const names = new Set((await client.listTools()).tools.map(tool => tool.name));
  assert.ok(names.has('status'));
  assert.ok(names.has('tabs_list'));
  assert.ok(names.has('tools_call'));
  assert.ok(!names.has('clock_advance'));
  assert.ok(!names.has('net_mock'));
  assert.ok(!names.has('evaluate'));

  await f.browser.tabs();
  assert.equal(f.calls.at(-1).timeoutMs, 30000);
});

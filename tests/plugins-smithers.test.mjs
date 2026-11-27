import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Browser,
  DubRuntime,
  NativeBridge,
  createCommands,
  listen,
} from '../dist/index.js';

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

async function startFixtureSocket(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dub-plugin-test-'));
  const sock = join(dir, 'browser.sock');
  const rules = new Map();
  const scripts = new Map();
  const exposed = new Set();
  const callbackReplies = new Map();
  const subscribers = new Set();

  const server = createNetServer(conn => {
    let buf = Buffer.alloc(0);
    conn.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (buf.length < 4 + size) break;
        const msg = JSON.parse(buf.subarray(4, 4 + size).toString('utf8'));
        buf = buf.subarray(4 + size);

        const reply = result => conn.write(frame({ protocol: 1, id: msg.id, result }));
        const fail = (code, message) => conn.write(frame({ protocol: 1, id: msg.id, error: { code, message } }));

        if (msg.method === 'events.subscribe') {
          subscribers.add(conn);
          conn.once('close', () => subscribers.delete(conn));
          reply({ subscribed: true, streamId: 'stream-1' });
          return;
        }
        if (msg.method === 'browser.info') {
          reply({
            product: 'Dub', protocol: 1, chromium: '157.0.8082.0', revision: 'fixture',
            profile: '/tmp/dub-fixture',
            methods: [
              'browser.info', 'tabs.list', 'tabs.open', 'tabs.navigate', 'page.evaluate',
              'tools.list', 'tools.call', 'net.set', 'net.list', 'net.remove', 'net.remove_by_plugin',
              'net.log', 'dialog.policy', 'scripts.add', 'scripts.remove', 'scripts.list',
              'scripts.expose', 'scripts.unexpose', 'scripts.remove_by_plugin',
              'events.subscribe', 'callback.respond', 'callbacks.list',
            ],
            tools: ['actor.click', 'actor.hover', 'actor.key'],
          });
        } else if (msg.method === 'tabs.list') {
          reply({ tabs: [{ id: 1, url: 'https://app.acme.test/dashboard', title: 'Acme', active: true, loading: false }] });
        } else if (msg.method === 'tools.list') {
          reply({ tools: [{ name: 'actor.click', source: 'actor', description: 'Click' }] });
        } else if (msg.method === 'tools.call') {
          reply({ code: 0, message: `called ${msg.params.name}` });
        } else if (msg.method === 'net.set') {
          const id = msg.params.id ?? `rule-${rules.size + 1}`;
          rules.set(id, { ...msg.params, id });
          reply({ id, version: rules.size, rule: rules.get(id) });
        } else if (msg.method === 'net.list') {
          reply({ version: rules.size, rules: [...rules.values()] });
        } else if (msg.method === 'net.remove') {
          rules.delete(msg.params.id);
          reply({ removed: true, id: msg.params.id });
        } else if (msg.method === 'net.remove_by_plugin') {
          let removed = 0;
          for (const [k, v] of [...rules]) {
            if (v.pluginId === msg.params.pluginId) { rules.delete(k); removed++; }
          }
          reply({ pluginId: msg.params.pluginId, removed });
        } else if (msg.method === 'scripts.add') {
          const id = msg.params.id ?? `script-${scripts.size + 1}`;
          scripts.set(id, { ...msg.params, id });
          reply({ id, match: msg.params.match ?? '*', world: msg.params.world ?? 'main', allFrames: true });
        } else if (msg.method === 'scripts.remove_by_plugin') {
          let removed = 0;
          for (const [k, v] of [...scripts]) {
            if (v.pluginId === msg.params.pluginId) { scripts.delete(k); removed++; }
          }
          reply({ pluginId: msg.params.pluginId, removed });
        } else if (msg.method === 'scripts.expose') {
          exposed.add(msg.params.name);
          reply({ exposed: true, name: msg.params.name });
        } else if (msg.method === 'dialog.policy') {
          reply({ mode: msg.params.mode ?? 'default', promptText: '', timeoutMs: 15000 });
        } else if (msg.method === 'callback.respond') {
          callbackReplies.set(msg.params.callbackId, msg.params.decision);
          reply({ ok: true, callbackId: msg.params.callbackId });
        } else {
          fail('METHOD_NOT_FOUND', `Unhandled fixture method: ${msg.method}`);
        }
        conn.end();
      }
    });
  });

  server.listen(sock);
  await once(server, 'listening');
  t.after(async () => {
    for (const s of subscribers) s.destroy();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    sock,
    rules,
    scripts,
    exposed,
    callbackReplies,
    pushFrame(obj) {
      const f = frame(obj);
      for (const s of subscribers) s.write(f);
    },
  };
}

test('N-API subscribe() receives pushed stream events and callbacks and closes cleanly', async t => {
  const fx = await startFixtureSocket(t);
  const bridge = new NativeBridge(fx.sock, 5000);
  const received = [];

  const sub = await bridge.subscribe({
    onMessage: msg => received.push(msg),
  });
  assert.equal(sub.streamId, 'stream-1');

  fx.pushFrame({ protocol: 1, type: 'event', event: 'tab.navigated', data: { tab: 1, url: 'https://example.test' } });
  fx.pushFrame({ protocol: 1, type: 'callback', callbackId: 'cb-1', kind: 'net.request', deadlineMs: 5000, data: { url: 'https://api.test' } });

  for (let i = 0; i < 40 && received.length < 2; i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  sub.close();
  assert.equal(received.length, 2);
  assert.equal(received[0].type, 'event');
  assert.equal(received[0].event, 'tab.navigated');
  assert.equal(received[1].type, 'callback');
  assert.equal(received[1].callbackId, 'cb-1');
});

test('Smithers QuickJS code mode runs TypeScript cells in persistent REPL realms with Dub flows, Jev, and BYO agent', async t => {
  const fx = await startFixtureSocket(t);
  const browser = new Browser(new NativeBridge(fx.sock, 5000));
  const rt = new DubRuntime(browser, {
    jev: {
      script: req => {
        const answers = {};
        for (const [id, q] of Object.entries(req.questions)) {
          if (q.type === 'boolean') answers[id] = { probability: 0.96 };
          else if (q.type === 'choice') answers[id] = { choice: q.options[0] };
          else answers[id] = { score: 0.9 };
        }
        return answers;
      },
    },
    agent: {
      kind: 'custom',
      handler: async turn => ({
        text: 'Rewriting response via agent cell',
        code: `
          const payload: { role?: string } = { role: "admin", via: ${JSON.stringify(turn.event)} };
          ctx.done({ action: "mock", status: 200, body: JSON.stringify(payload) });
        `,
      }),
    },
  });
  t.after(() => rt.close());

  // Frame 1: bind a typed variable and query browser tabs
  const f1 = await rt.code.evaluate(
    `
    const tabsRes: { tabs: Array<{ id: number; url: string }> } = await ctx.call("dub.tabs.list", {});
    const primaryTabId: number = tabsRes.tabs[0].id;
    console.log("bound tab", primaryTabId);
    ctx.done({ primaryTabId, url: tabsRes.tabs[0].url });
    `,
    { realmId: 'session-a' }
  );
  assert.equal(f1.ok, true, JSON.stringify(f1));
  assert.equal(f1.outcome, 'done');
  assert.equal(f1.output.primaryTabId, 1);
  assert.match(f1.prints, /bound tab 1/);

  // Frame 2: reuse `primaryTabId` from Frame 1, call Jev AND call BYO agent (which itself emits a cell!)
  const f2 = await rt.code.evaluate(
    `
    const verdict = await ctx.call("jev", {
      state: { tab: primaryTabId, role: "viewer" },
      questions: {
        promote: { type: "boolean", instructions: "Should this test user be promoted to admin?" },
        route: { type: "choice", options: ["rewrite", "pass"], instructions: "Which action?" }
      }
    });
    const turnRes = await ctx.call("agent.turn", {
      event: "net.response",
      prompt: "Upgrade user to admin",
      payload: { tab: primaryTabId, verdict: verdict.answers }
    });
    ctx.done({ tab: primaryTabId, verdict: verdict.answers, turn: turnRes });
    `,
    { realmId: 'session-a' }
  );
  assert.equal(f2.ok, true, JSON.stringify(f2));
  assert.equal(f2.output.tab, 1);
  assert.equal(f2.output.verdict.promote, true);
  assert.equal(f2.output.verdict.route, 'rewrite');
  assert.equal(f2.output.turn.executedCell, true);
  assert.equal(f2.output.turn.decision.action, 'mock');
  assert.equal(JSON.parse(f2.output.turn.decision.body).role, 'admin');
});

test('Reactive triggers support code, jev->agent escalation, and universal MCP handoff turns over live push stream', async t => {
  const fx = await startFixtureSocket(t);
  const browser = new Browser(new NativeBridge(fx.sock, 5000));
  const agentCalls = [];
  const rt = new DubRuntime(browser, {
    jev: {
      script: req => {
        const body = String(req.state.body ?? '');
        return {
          needsRewrite: { probability: body.includes('PAYWALL') ? 0.99 : 0.02 },
        };
      },
    },
    agent: {
      kind: 'custom',
      handler: async turn => {
        agentCalls.push(turn);
        return {
          decision: {
            action: 'modify',
            status: 200,
            body: JSON.stringify({ unlocked: true, turnId: turn.turnId }),
          },
        };
      },
    },
  });
  t.after(() => rt.close());

  // 1. Jev trigger that passes normal responses and escalates PAYWALL responses to a new BYO agent turn!
  const jevTrig = await rt.triggers.register({
    on: 'net.response',
    match: '*/api/article*',
    mode: 'jev',
    questions: {
      needsRewrite: { type: 'boolean', instructions: 'Does this response contain a paywall?' },
    },
    jevRoutes: {
      true: 'agent',
      false: { action: 'continue' },
    },
    prompt: 'Rewrite paywalled response to unlocked content',
  });
  assert.ok(fx.rules.has(jevTrig.networkRuleId));

  // Push a normal response -> Jev returns false -> continue without calling BYO agent
  fx.pushFrame({
    protocol: 1,
    type: 'callback',
    callbackId: 'cb-normal',
    kind: 'net.response',
    deadlineMs: 5000,
    data: { ruleId: jevTrig.networkRuleId, url: 'https://news.test/api/article/1', body: '{"ok":true}' },
  });
  for (let i = 0; i < 60 && !fx.callbackReplies.has('cb-normal'); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(fx.callbackReplies.get('cb-normal').action, 'continue');
  assert.equal(agentCalls.length, 0);

  // Push a PAYWALL response -> Jev returns true -> escalates to new BYO agent turn -> rewrites!
  fx.pushFrame({
    protocol: 1,
    type: 'callback',
    callbackId: 'cb-paywall',
    kind: 'net.response',
    deadlineMs: 5000,
    data: { ruleId: jevTrig.networkRuleId, url: 'https://news.test/api/article/2', body: '{"error":"PAYWALL"}' },
  });
  for (let i = 0; i < 60 && !fx.callbackReplies.has('cb-paywall'); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(agentCalls.length, 1);
  assert.equal(fx.callbackReplies.get('cb-paywall').action, 'modify');
  assert.equal(JSON.parse(fx.callbackReplies.get('cb-paywall').body).unlocked, true);

  // 2. Switch agent to universal 'handoff' mode and prove MCP client turn handoff (`triggers_await` + `triggers_resolve`)
  rt.agent.configure({ kind: 'handoff' });
  const handoffTrig = await rt.triggers.register({
    on: 'net.request',
    match: '*/api/checkout*',
    mode: 'agent',
    prompt: 'Decide how to mock checkout',
  });

  const awaitPromise = rt.agent.awaitTurn(5000);
  fx.pushFrame({
    protocol: 1,
    type: 'callback',
    callbackId: 'cb-checkout',
    kind: 'net.request',
    deadlineMs: 5000,
    data: { ruleId: handoffTrig.networkRuleId, url: 'https://shop.test/api/checkout', method: 'POST', body: '{"total":99}' },
  });
  const pendingTurn = await awaitPromise;
  assert.ok(pendingTurn);
  assert.equal(pendingTurn.event, 'net.request');

  // External LLM resolves the turn with a Smithers code-mode TypeScript cell!
  assert.equal(
    rt.agent.resolveTurn(pendingTurn.turnId, {
      code: `
        const parsed: { total: number } = JSON.parse(event.body);
        ctx.done({ action: "mock", status: 200, body: JSON.stringify({ charged: 0, waived: parsed.total }) });
      `,
    }),
    true
  );
  for (let i = 0; i < 60 && !fx.callbackReplies.has('cb-checkout'); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(fx.callbackReplies.get('cb-checkout').action, 'mock');
  assert.equal(JSON.parse(fx.callbackReplies.get('cb-checkout').body).waived, 99);
});

test('TypeScript code plugins load, hot-reload, add synthetic WebMCP & custom tools, intercept callbacks, and atomically tear down via MCP', async t => {
  const fx = await startFixtureSocket(t);
  const browser = new Browser(new NativeBridge(fx.sock, 5000));
  const rt = new DubRuntime(browser);
  t.after(() => rt.close());

  const pluginPath = join(fx.dir, 'acme-plugin.ts');
  await writeFile(
    pluginPath,
    `
    interface UserPayload { role: string; version: number }
    export default {
      name: 'acme-plugin',
      description: 'Demo TS plugin for Acme',
      async setup(dub: any) {
        await dub.addInitScript('https://app.acme.test/*', 'const tag: string = "v1"; (window as any).__acmeTag = tag;');
        await dub.net.handle('https://app.acme.test/api/user', async (req: any) => {
          const payload: UserPayload = { role: 'superadmin', version: 1 };
          return { action: 'mock', status: 200, json: payload };
        });
        dub.tool({
          name: 'acme.greet',
          description: 'Custom TS plugin tool',
          run: async (input: { who?: string }) => ({ greeting: 'hello ' + (input.who ?? 'world'), version: 1 }),
        });
        dub.pageTool({
          match: 'https://app.acme.test/*',
          name: 'quick_approve',
          description: 'Synthetic WebMCP tool for Acme',
          run: async (input: { id: string }) => ({ approved: input.id, source: 'synthetic-webmcp' }),
        });
      },
    };
    `,
    'utf8'
  );

  // Serve MCP HTTP server with our runtime
  const cli = createCommands(browser, undefined, rt);
  const http = await listen(cli.fetch, { host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'dub-plugin-mcp-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`));
  await client.connect(transport);
  t.after(async () => {
    await transport.close().catch(() => {});
    await http.close().catch(() => {});
  });

  // Load TS plugin over MCP!
  const loadRes = await client.callTool({ name: 'plugin_load', arguments: { file: pluginPath } });
  assert.notEqual(loadRes.isError, true, JSON.stringify(loadRes));
  const loadData = JSON.parse(loadRes.content[0].text);
  assert.equal(loadData.name, 'acme-plugin');
  assert.deepEqual(loadData.tools, ['acme.greet']);
  assert.deepEqual(loadData.pageTools, ['page.quick_approve']);

  // Verify init script was transpiled from TS to plain JS!
  const addedScript = [...fx.scripts.values()][0];
  assert.ok(addedScript);
  assert.ok(!addedScript.source.includes(': string'), `TS types should be stripped: ${addedScript.source}`);
  assert.ok(addedScript.source.includes('__acmeTag'));

  // Verify tools_list surfaces BOTH synthetic WebMCP (`page.quick_approve`) and custom tool (`acme.greet`)
  const listRes = await client.callTool({ name: 'tools_list', arguments: { tab: 1 } });
  const toolNames = JSON.parse(listRes.content[0].text).tools.map(x => x.name);
  assert.ok(toolNames.includes('page.quick_approve'));
  assert.ok(toolNames.includes('acme.greet'));

  // Invoke synthetic WebMCP tool & custom plugin tool via MCP tools_call!
  const synRes = await client.callTool({
    name: 'tools_call',
    arguments: { tab: 1, name: 'page.quick_approve', input: JSON.stringify({ id: 'INV-42' }) },
  });
  assert.deepEqual(JSON.parse(synRes.content[0].text), { approved: 'INV-42', source: 'synthetic-webmcp' });

  const customRes = await client.callTool({
    name: 'tools_call',
    arguments: { tab: 1, name: 'acme.greet', input: JSON.stringify({ who: 'Will' }) },
  });
  assert.deepEqual(JSON.parse(customRes.content[0].text), { greeting: 'hello Will', version: 1 });

  // Verify live network callback registered by TS plugin responds to Chromium stream callback!
  const cbRule = [...fx.rules.values()].find(r => r.pluginId === 'acme-plugin');
  assert.ok(cbRule);
  fx.pushFrame({
    protocol: 1,
    type: 'callback',
    callbackId: 'cb-acme-1',
    kind: 'net.request',
    deadlineMs: 5000,
    data: { ruleId: cbRule.id, url: 'https://app.acme.test/api/user', method: 'GET', body: '' },
  });
  for (let i = 0; i < 60 && !fx.callbackReplies.has('cb-acme-1'); i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(JSON.parse(fx.callbackReplies.get('cb-acme-1').body).role, 'superadmin');

  // Edit TS plugin on disk -> hot-reload over MCP!
  await writeFile(
    pluginPath,
    `
    export default {
      name: 'acme-plugin',
      setup(dub: any) {
        dub.tool({
          name: 'acme.greet',
          description: 'Reloaded v2',
          run: async () => ({ greeting: 'reloaded', version: 2 }),
        });
      },
    };
    `,
    'utf8'
  );
  const reloadRes = await client.callTool({ name: 'plugin_reload', arguments: { name: 'acme-plugin' } });
  assert.notEqual(reloadRes.isError, true, JSON.stringify(reloadRes));
  const v2Res = await client.callTool({
    name: 'tools_call',
    arguments: { tab: 1, name: 'acme.greet', input: '{}' },
  });
  assert.equal(JSON.parse(v2Res.content[0].text).version, 2);

  // Atomic teardown on plugin_unload!
  const unloadRes = await client.callTool({ name: 'plugin_unload', arguments: { name: 'acme-plugin' } });
  assert.equal(JSON.parse(unloadRes.content[0].text).unloaded, true);
  assert.equal(fx.rules.size, 0);
  assert.equal(fx.scripts.size, 0);
});

test('BYO Agent HTTP webhook and CLI adapters work end-to-end', async t => {
  const fx = await startFixtureSocket(t);
  const browser = new Browser(new NativeBridge(fx.sock, 5000));

  // Local HTTP webhook acting as user's BYO agent
  const agentServer = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ decision: { action: 'mock', status: 201, body: `agent-saw:${body.event}` } })
    );
  });
  agentServer.listen(0, '127.0.0.1');
  await once(agentServer, 'listening');
  t.after(() => agentServer.close());
  const port = agentServer.address().port;

  const rt = new DubRuntime(browser, {
    agent: { kind: 'http', url: `http://127.0.0.1:${port}/turn`, format: 'webhook' },
  });
  t.after(() => rt.close());

  const httpTurn = await rt.agent.runTurn({ event: 'net.request', prompt: 'Rewrite', payload: { url: 'https://x.test' } });
  assert.equal(httpTurn.adapter, 'http');
  assert.equal(httpTurn.decision.body, 'agent-saw:net.request');

  // CLI adapter using node as a BYO agent script
  rt.agent.configure({
    kind: 'cli',
    command: process.execPath,
    args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({action:"modify",seen:r.event}));});'],
  });
  const cliTurn = await rt.agent.runTurn({ event: 'page.dialog', prompt: 'Handle dialog', payload: { message: 'Confirm?' } });
  assert.equal(cliTurn.adapter, 'cli');
  assert.equal(cliTurn.decision.seen, 'page.dialog');
});

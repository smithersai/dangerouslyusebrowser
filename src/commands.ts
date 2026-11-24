import { Cli, z } from 'incur';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser, duration } from './browser.js';
import { attachProfile } from './launch.js';

const tab = z.number().int().positive().describe('Stable tab ID from tabs list');
const jsonObject = z.string().default('{}').describe('Tool arguments encoded as a JSON object');
function parseInput(value: string) {
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(value)); }
  catch { throw new Error('Expected a JSON object for --input'); }
}

export type Capabilities = { methods?: readonly string[]; tools?: readonly string[] };

export function createCommands(browser: Browser, capabilities?: Capabilities) {
  const allowed = capabilities?.methods ? new Set(capabilities.methods) : undefined;
  const has = (method: string) => !allowed || allowed.has(method);

  const cli = Cli.create('dub', {
    description: 'DangerouslyUseBrowser — direct control of a forked Chromium', version: '0.1.0-alpha.1',
    mcp: { tools: { discovery: 'direct' } },
  });
  if (has('browser.info')) {
    cli.command('status', { description: 'Identify the running Dub fork and its native capabilities', run: () => browser.info() });
  }
  const tabMethods = ['tabs.list', 'tabs.open', 'tabs.close', 'tabs.activate', 'tabs.navigate'];
  if (tabMethods.some(has)) {
    const tabs = Cli.create('tabs', { description: 'Persistent browser tabs' });
    if (has('tabs.list')) tabs.command('list', { description: 'List tabs with stable IDs', run: () => browser.tabs() });
    if (has('tabs.open')) tabs.command('open', { description: 'Open a tab', options: z.object({ url: z.string().default('about:blank') }), run: c => browser.open(c.options.url) });
    if (has('tabs.close')) tabs.command('close', { description: 'Close a tab', options: z.object({ tab }), run: c => browser.close(c.options.tab) });
    if (has('tabs.activate')) tabs.command('activate', { description: 'Activate a tab', options: z.object({ tab }), run: c => browser.activate(c.options.tab) });
    if (has('tabs.navigate')) tabs.command('navigate', { description: 'Navigate a tab', options: z.object({ tab, url: z.string().min(1) }), run: c => browser.navigate(c.options.tab, c.options.url) });
    cli.command(tabs);
  }
  if (has('page.evaluate')) {
    cli.command('evaluate', {
      description: 'Evaluate JavaScript in the main frame of a tab', options: z.object({ tab, expression: z.string().min(1) }),
      run: c => browser.evaluate(c.options.tab, c.options.expression),
    });
  }
  if (has('page.screenshot')) {
    cli.command('screenshot', {
      description: 'Capture a tab as PNG; optionally write it on the server', options: z.object({ tab, out: z.string().optional() }),
      async run(c) { const shot = await browser.screenshot(c.options.tab); if (!c.options.out) return shot;
        await writeFile(c.options.out, Buffer.from(shot.data, 'base64')); return { path: c.options.out, mimeType: shot.mimeType }; },
    });
  }
  if (has('tools.list') || has('tools.call')) {
    const tools = Cli.create('tools', { description: 'Chromium actor and page WebMCP tools' });
    if (has('tools.list')) tools.command('list', { description: 'Discover native actor and site-registered tools', options: z.object({ tab }), run: c => browser.tools(c.options.tab) });
    if (has('tools.call')) tools.command('call', { description: 'Invoke a native actor or page tool', args: z.object({ name: z.string().min(1) }), options: z.object({ tab, input: jsonObject }), run: c => browser.tool(c.options.tab, c.args.name, parseInput(c.options.input)) });
    cli.command(tools);
  }
  if (['net.set', 'net.list', 'net.remove', 'net.log'].some(has)) {
    const net = Cli.create('net', { description: 'Live browser-wide network rules' });
    if (has('net.set')) {
      net.command('rewrite', { description: 'Return a mock response; body is a file on the server', options: z.object({ match: z.string().min(1), status: z.number().int().min(200).max(599).default(200), body: z.string(), contentType: z.string().default('application/json') }),
        async run(c) { return browser.setRule({ match: c.options.match, action: 'mock', status: c.options.status, body: await readFile(c.options.body, 'utf8'), headers: { 'content-type': c.options.contentType } }); } });
      net.command('mock', { description: 'Return a mock response from inline content', options: z.object({ match: z.string().min(1), body: z.string(), status: z.number().int().min(200).max(599).default(200), contentType: z.string().default('application/json') }), run: c => browser.setRule({ match: c.options.match, body: c.options.body, status: c.options.status, headers: { 'content-type': c.options.contentType }, action: 'mock' }) });
      net.command('block', { description: 'Block matching requests', options: z.object({ match: z.string().min(1) }), run: c => browser.setRule({ ...c.options, action: 'block' }) });
      net.command('redirect', { description: 'Rewrite matching outgoing URLs', options: z.object({ match: z.string().min(1), url: z.string().url() }), run: c => browser.setRule({ ...c.options, action: 'redirect' }) });
      net.command('patch', { description: 'Replace text in matching response bodies', options: z.object({ match: z.string().min(1), replace: z.string().min(1), with: z.string() }), run: c => browser.setRule({ ...c.options, action: 'patch' }) });
    }
    if (has('net.list')) net.command('list', { description: 'List live rules', run: () => browser.rules() });
    if (has('net.remove')) net.command('remove', { description: 'Remove a rule', options: z.object({ id: z.string().min(1) }), run: c => browser.removeRule(c.options.id) });
    if (has('net.log')) {
      net.command('log', {
        description: 'Read or follow the bounded network log after a sequence number',
        options: z.object({
          match: z.string().default(''),
          since: z.number().int().min(0).default(0),
          follow: z.boolean().default(false).describe('Poll for new entries until limit or timeoutMs'),
          limit: z.number().int().min(1).max(2000).default(100),
          timeoutMs: z.number().int().min(100).max(60000).default(3000),
        }),
        async run(c) {
          if (!c.options.follow) {
            return browser.networkLog(c.options.match, c.options.since);
          }
          let cursor = c.options.since;
          let gap = false;
          let droppedCount = 0;
          let oldestSeq = 0;
          let version = 0;
          const entries: Array<Record<string, unknown>> = [];
          const deadline = Date.now() + c.options.timeoutMs;
          while (Date.now() < deadline && entries.length < c.options.limit) {
            const page = (await browser.networkLog(c.options.match, cursor)) as {
              entries: Array<Record<string, unknown>>;
              nextSeq: number;
              oldestSeq: number;
              droppedCount: number;
              gap: boolean;
              version: number;
            };
            version = page.version;
            oldestSeq = page.oldestSeq;
            droppedCount = page.droppedCount;
            if (page.gap) gap = true;
            for (const entry of page.entries) {
              entries.push(entry);
              if (entries.length >= c.options.limit) break;
            }
            if (page.nextSeq > cursor) cursor = page.nextSeq;
            if (entries.length >= c.options.limit) break;
            await delay(Math.min(100, Math.max(0, deadline - Date.now())));
          }
          return { followed: true, version, nextSeq: cursor, oldestSeq, droppedCount, gap, entries };
        },
      });
    }
    cli.command(net);
  }
  if (['clock.freeze', 'clock.advance', 'clock.step', 'clock.resume'].some(has)) {
    const clock = Cli.create('clock', { description: 'Engine-level virtual time' });
    if (has('clock.freeze')) clock.command('freeze', { description: 'Freeze the selected tab at an ISO date', options: z.object({ tab, at: z.iso.datetime({ offset: true }) }), run: c => browser.freeze(c.options.tab, c.options.at) });
    if (has('clock.advance')) clock.command('advance', { description: 'Advance virtual time by a duration', options: z.object({ tab, by: z.string() }), run: c => browser.advance(c.options.tab, duration(c.options.by)) });
    if (has('clock.step')) clock.command('step', { description: 'Advance animation frames', options: z.object({ tab, frames: z.number().int().min(1).max(600).default(1) }), run: c => browser.step(c.options.tab, c.options.frames) });
    if (has('clock.resume')) clock.command('resume', { description: 'Resume real time', options: z.object({ tab }), run: c => browser.resume(c.options.tab) });
    cli.command(clock);
  }
  if (has('profile.info') || has('profile.clear')) {
    const profile = Cli.create('profile', { description: 'Selected browser profile and storage' });
    if (has('profile.info')) profile.command('info', { description: 'Inspect the selected profile', run: () => browser.profileInfo() });
    if (has('profile.clear')) profile.command('clear', { description: 'Clear storage for the selected profile', options: z.object({ types: z.string().optional().describe('Comma-separated: cookies,localStorage,indexedDB,cache,serviceWorkers,all') }), run: c => browser.profileClear(c.options.types ? c.options.types.split(',').map(s => s.trim()).filter(Boolean) : undefined) });
    profile.command('attach', {
      description: 'Inspect or reconnect to a Dub session for a named profile without silently attaching to stock Chrome',
      options: z.object({
        name: z.string().min(1).default('Default'),
        dir: z.string().optional(),
        socket: z.string().optional(),
      }),
      run: c => attachProfile({
        name: c.options.name,
        dir: c.options.dir,
        socket: c.options.socket ?? browser.native.socket,
      }),
    });
    cli.command(profile);
  }
  return cli;
}

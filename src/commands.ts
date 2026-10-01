import { Cli, z } from 'incur';
import { readFile, writeFile } from 'node:fs/promises';
import { Browser, duration } from './browser.js';

const tab = z.number().int().positive().describe('Stable tab ID from tabs list');
const jsonObject = z.string().default('{}').describe('Tool arguments encoded as a JSON object');
function parseInput(value: string) {
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(value)); }
  catch { throw new Error('Expected a JSON object for --input'); }
}

export function createCommands(browser: Browser) {
  const cli = Cli.create('dub', {
    description: 'DangerouslyUseBrowser — direct control of a forked Chromium', version: '0.1.0-alpha.1',
    mcp: { tools: { discovery: 'direct' } },
  }).command('status', { description: 'Identify the running Dub fork and its native capabilities', run: () => browser.info() });
  cli.command(Cli.create('tabs', { description: 'Persistent browser tabs' })
    .command('list', { description: 'List tabs with stable IDs', run: () => browser.tabs() })
    .command('open', { description: 'Open a tab', options: z.object({ url: z.string().default('about:blank') }), run: c => browser.open(c.options.url) })
    .command('close', { description: 'Close a tab', options: z.object({ tab }), run: c => browser.close(c.options.tab) })
    .command('activate', { description: 'Activate a tab', options: z.object({ tab }), run: c => browser.activate(c.options.tab) })
    .command('navigate', { description: 'Navigate a tab', options: z.object({ tab, url: z.string().min(1) }), run: c => browser.navigate(c.options.tab, c.options.url) }));
  cli.command('evaluate', {
    description: 'Evaluate JavaScript in the main frame of a tab', options: z.object({ tab, expression: z.string().min(1) }),
    run: c => browser.evaluate(c.options.tab, c.options.expression),
  });
  cli.command('screenshot', {
    description: 'Capture a tab as PNG; optionally write it on the server', options: z.object({ tab, out: z.string().optional() }),
    async run(c) { const shot = await browser.screenshot(c.options.tab); if (!c.options.out) return shot;
      await writeFile(c.options.out, Buffer.from(shot.data, 'base64')); return { path: c.options.out, mimeType: shot.mimeType }; },
  });
  cli.command(Cli.create('tools', { description: 'Chromium actor and page WebMCP tools' })
    .command('list', { description: 'Discover native actor and site-registered tools', options: z.object({ tab }), run: c => browser.tools(c.options.tab) })
    .command('call', { description: 'Invoke a native actor or page tool', args: z.object({ name: z.string().min(1) }), options: z.object({ tab, input: jsonObject }), run: c => browser.tool(c.options.tab, c.args.name, parseInput(c.options.input)) }));
  cli.command(Cli.create('net', { description: 'Live browser-wide network rules' })
    .command('rewrite', { description: 'Return a mock response; body is a file on the server', options: z.object({ match: z.string().min(1), status: z.number().int().min(200).max(599).default(200), body: z.string(), contentType: z.string().default('application/json') }),
      async run(c) { return browser.setRule({ match: c.options.match, action: 'mock', status: c.options.status, body: await readFile(c.options.body, 'utf8'), headers: { 'content-type': c.options.contentType } }); } })
    .command('mock', { description: 'Return a mock response from inline content', options: z.object({ match: z.string().min(1), body: z.string(), status: z.number().int().min(200).max(599).default(200), contentType: z.string().default('application/json') }), run: c => browser.setRule({ match: c.options.match, body: c.options.body, status: c.options.status, headers: { 'content-type': c.options.contentType }, action: 'mock' }) })
    .command('block', { description: 'Block matching requests', options: z.object({ match: z.string().min(1) }), run: c => browser.setRule({ ...c.options, action: 'block' }) })
    .command('redirect', { description: 'Rewrite matching outgoing URLs', options: z.object({ match: z.string().min(1), url: z.string().url() }), run: c => browser.setRule({ ...c.options, action: 'redirect' }) })
    .command('patch', { description: 'Replace text in matching response bodies', options: z.object({ match: z.string().min(1), replace: z.string().min(1), with: z.string() }), run: c => browser.setRule({ ...c.options, action: 'patch' }) })
    .command('list', { description: 'List live rules', run: () => browser.rules() })
    .command('remove', { description: 'Remove a rule', options: z.object({ id: z.string().min(1) }), run: c => browser.removeRule(c.options.id) })
    .command('log', { description: 'Read the bounded network log after a sequence number', options: z.object({ match: z.string().default(''), since: z.number().int().min(0).default(0) }), run: c => browser.networkLog(c.options.match, c.options.since) }));
  cli.command(Cli.create('clock', { description: 'Engine-level virtual time' })
    .command('freeze', { description: 'Freeze the selected tab at an ISO date', options: z.object({ tab, at: z.iso.datetime({ offset: true }) }), run: c => browser.freeze(c.options.tab, c.options.at) })
    .command('advance', { description: 'Advance virtual time by a duration', options: z.object({ tab, by: z.string() }), run: c => browser.advance(c.options.tab, duration(c.options.by)) })
    .command('step', { description: 'Advance animation frames', options: z.object({ tab, frames: z.number().int().min(1).max(600).default(1) }), run: c => browser.step(c.options.tab, c.options.frames) })
    .command('resume', { description: 'Resume real time', options: z.object({ tab }), run: c => browser.resume(c.options.tab) }));
  return cli;
}

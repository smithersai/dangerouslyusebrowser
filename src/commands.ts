import { Cli, z } from 'incur';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser, duration, type WaitUntil } from './browser.js';
import { attachProfile } from './launch.js';
import { DubRuntime } from './runtime.js';
import { transpileTypeScript } from './plugins.js';
import type { JevQuestion } from './jev.js';
import type { TriggerEventType, TriggerMode } from './triggers.js';

const tab = z.number().int().positive().describe('Stable tab ID from tabs list');
const jsonObject = z.string().default('{}').describe('Arguments encoded as a JSON object');
const waitUntilOpt = z.enum(['none', 'commit', 'domcontentloaded', 'load', 'networkidle']).default('none');

function parseJsonObject(value: string, label = '--input'): Record<string, unknown> {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(value));
  } catch {
    throw new Error(`Expected a JSON object for ${label}`);
  }
}

export type Capabilities = { methods?: readonly string[]; tools?: readonly string[] };

type CommandContext = {
  cli: ReturnType<typeof Cli.create>;
  browser: Browser;
  rt: DubRuntime;
  has: (method: string) => boolean;
  wrap: <T>(name: string, input: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;
};

function registerTabsAndFrames({ cli, browser, has, wrap }: CommandContext): void {
  if (has('browser.info')) {
    cli.command('status', {
      description: 'Identify the running Dub fork and its native capabilities',
      run: () => wrap('browser.info', {}, () => browser.info()),
    });
  }

  const tabMethods = ['tabs.list', 'tabs.open', 'tabs.close', 'tabs.activate', 'tabs.navigate', 'tabs.back', 'tabs.forward', 'tabs.reload'];
  if (tabMethods.some(has)) {
    const tabs = Cli.create('tabs', { description: 'Persistent and ephemeral browser tabs' });
    if (has('tabs.list')) tabs.command('list', { description: 'List tabs with stable IDs', run: () => browser.tabs() });
    if (has('tabs.open')) {
      tabs.command('open', {
        description: 'Open a tab (persistent or ephemeral/OTR)',
        options: z.object({
          url: z.string().default('about:blank'),
          waitUntil: waitUntilOpt,
          ephemeral: z.boolean().default(false).describe('Open in an isolated off-the-record context'),
        }),
        run: c => wrap('tabs.open', c.options, () => browser.open(c.options.url, { waitUntil: c.options.waitUntil as WaitUntil, ephemeral: c.options.ephemeral })),
      });
    }
    if (has('tabs.close')) tabs.command('close', { description: 'Close a tab', options: z.object({ tab }), run: c => browser.close(c.options.tab) });
    if (has('tabs.activate')) tabs.command('activate', { description: 'Activate a tab', options: z.object({ tab }), run: c => browser.activate(c.options.tab) });
    if (has('tabs.navigate')) {
      tabs.command('navigate', {
        description: 'Navigate a tab',
        options: z.object({ tab, url: z.string().min(1), waitUntil: waitUntilOpt }),
        run: c => wrap('tabs.navigate', c.options, () => browser.navigate(c.options.tab, c.options.url, { waitUntil: c.options.waitUntil as WaitUntil })),
      });
    }
    if (has('tabs.back')) tabs.command('back', { description: 'Go back in tab history', options: z.object({ tab, waitUntil: waitUntilOpt }), run: c => browser.back(c.options.tab, { waitUntil: c.options.waitUntil as WaitUntil }) });
    if (has('tabs.forward')) tabs.command('forward', { description: 'Go forward in tab history', options: z.object({ tab, waitUntil: waitUntilOpt }), run: c => browser.forward(c.options.tab, { waitUntil: c.options.waitUntil as WaitUntil }) });
    if (has('tabs.reload')) {
      tabs.command('reload', {
        description: 'Reload a tab',
        options: z.object({ tab, ignoreCache: z.boolean().default(false), waitUntil: waitUntilOpt }),
        run: c => browser.reload(c.options.tab, { ignoreCache: c.options.ignoreCache, waitUntil: c.options.waitUntil as WaitUntil }),
      });
    }
    cli.command(tabs);
  }

  if (has('frames.list')) {
    const frames = Cli.create('frames', { description: 'Inspect frames and iframes in a tab' });
    frames.command('list', { description: 'List live frames in a tab', options: z.object({ tab }), run: c => browser.frames(c.options.tab) });
    cli.command(frames);
  }
}

function registerPageCommands({ cli, browser, has, wrap }: CommandContext): void {
  if (['page.snapshot', 'page.console', 'page.wait', 'page.viewport', 'page.emulate'].some(has)) {
    const page = Cli.create('page', { description: 'Page observation, waiting, viewport, and emulation' });
    if (has('page.snapshot')) {
      page.command('snapshot', {
        description: 'Capture structured accessibility/interactive DOM snapshot with real Blink nodeIds (pierces Shadow DOM)',
        options: z.object({
          tab,
          frameId: z.string().optional(),
          maxNodes: z.number().int().min(1).max(2000).default(300),
          includeHidden: z.boolean().default(false),
        }),
        run: c => browser.snapshot(c.options.tab, { frameId: c.options.frameId, maxNodes: c.options.maxNodes, includeHidden: c.options.includeHidden }),
      });
    }
    if (has('page.console')) {
      page.command('console', {
        description: 'Read buffered console logs and uncaught errors for a tab',
        options: z.object({
          tab,
          since: z.number().int().min(0).default(0),
          level: z.enum(['all', 'debug', 'info', 'warning', 'error']).default('all'),
          clear: z.boolean().default(false),
        }),
        run: c => browser.console(c.options.tab, { since: c.options.since, level: c.options.level, clear: c.options.clear }),
      });
    }
    if (has('page.wait')) {
      page.command('wait', {
        description: 'Wait for a selector, visible text, or JS expression in a tab/frame',
        options: z.object({
          tab,
          frameId: z.string().optional(),
          selector: z.string().optional(),
          text: z.string().optional(),
          expression: z.string().optional(),
          state: z.enum(['attached', 'visible', 'hidden', 'detached']).default('visible'),
          timeoutMs: z.number().int().min(50).max(120000).default(10000),
        }),
        run: c => browser.wait(c.options.tab, {
          frameId: c.options.frameId,
          selector: c.options.selector,
          text: c.options.text,
          expression: c.options.expression,
          state: c.options.state,
          timeoutMs: c.options.timeoutMs,
        }),
      });
    }
    if (has('page.viewport')) {
      page.command('viewport', {
        description: 'Get or set the tab window/viewport dimensions',
        options: z.object({ tab, width: z.number().int().optional(), height: z.number().int().optional() }),
        run: c => browser.viewport(c.options.tab, { width: c.options.width, height: c.options.height }),
      });
    }
    if (has('page.emulate')) {
      page.command('emulate', {
        description: 'Per-tab emulation (colorScheme, userAgent, locale, geolocation, deterministic randomSeed)',
        options: z.object({
          tab,
          userAgent: z.string().optional(),
          colorScheme: z.enum(['dark', 'light']).optional(),
          locale: z.string().optional(),
          randomSeed: z.number().int().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        }),
        run: c => browser.emulate(c.options.tab, {
          userAgent: c.options.userAgent,
          colorScheme: c.options.colorScheme,
          locale: c.options.locale,
          randomSeed: c.options.randomSeed,
          ...(c.options.latitude !== undefined && c.options.longitude !== undefined
            ? { geolocation: { latitude: c.options.latitude, longitude: c.options.longitude } }
            : {}),
        }),
      });
    }
    cli.command(page);
  }
}

function registerEvalAndScreenshotCommands({ cli, browser, has, wrap }: CommandContext): void {
  if (has('page.evaluate')) {
    cli.command('evaluate', {
      description: 'Evaluate JavaScript in a tab frame (main or isolated world)',
      options: z.object({
        tab,
        expression: z.string().min(1),
        frameId: z.string().optional(),
        world: z.enum(['main', 'isolated']).default('main'),
      }),
      run: c => wrap('page.evaluate', c.options, () =>
        browser.evaluate(c.options.tab, c.options.expression, { frameId: c.options.frameId, world: c.options.world })
      ),
    });
  }

  if (has('page.screenshot')) {
    cli.command('screenshot', {
      description: 'Capture a tab as PNG or JPEG (optional clip region) and optionally write it on the server',
      options: z.object({
        tab,
        out: z.string().optional(),
        format: z.enum(['png', 'jpeg']).default('png'),
        quality: z.number().int().min(1).max(100).default(85),
        clipX: z.number().int().optional(),
        clipY: z.number().int().optional(),
        clipWidth: z.number().int().positive().optional(),
        clipHeight: z.number().int().positive().optional(),
      }),
      async run(c) {
        const clip =
          c.options.clipWidth && c.options.clipHeight
            ? { x: c.options.clipX ?? 0, y: c.options.clipY ?? 0, width: c.options.clipWidth, height: c.options.clipHeight }
            : undefined;
        const shot = await browser.screenshot(c.options.tab, { format: c.options.format, quality: c.options.quality, clip });
        if (!c.options.out) return shot;
        await writeFile(c.options.out, Buffer.from(shot.data, 'base64'));
        return { path: c.options.out, mimeType: shot.mimeType, width: shot.width, height: shot.height };
      },
    });
  }
}

function registerToolsCommands({ cli, browser, rt, has, wrap }: CommandContext): void {
  if (!has('tools.list') && !has('tools.call')) return;
  const tools = Cli.create('tools', { description: 'Chromium actor, WebMCP page tools, and plugin-registered tools' });
  if (has('tools.list')) {
    tools.command('list', {
      description: 'Discover native actor, WebMCP, and plugin-registered tools',
      options: z.object({ tab }),
      async run(c) {
        const nativeRes = await browser.tools(c.options.tab);
        const { tabs } = await browser.tabs().catch(() => ({ tabs: [] }));
        const tabInfo = tabs.find(t => t.id === c.options.tab);
        const synthetic = tabInfo ? rt.plugins.listSyntheticPageToolsForUrl(tabInfo.url) : [];
        const custom = rt.plugins.listCustomTools();
        return { tools: [...(nativeRes.tools ?? []), ...synthetic, ...custom] };
      },
    });
  }
  if (has('tools.call')) {
    tools.command('call', {
      description: 'Invoke a native actor, WebMCP, or plugin tool',
      args: z.object({ name: z.string().min(1) }),
      options: z.object({ tab, input: jsonObject }),
      async run(c) {
        const parsedInput = parseJsonObject(c.options.input);
        return wrap(`tools.call:${c.args.name}`, { tab: c.options.tab, ...parsedInput }, async () => {
          const { tabs } = await browser.tabs().catch(() => ({ tabs: [] }));
          const tabUrl = tabs.find(t => t.id === c.options.tab)?.url ?? '';
          const pluginHit = await rt.plugins.invokeCustomOrSyntheticTool(c.options.tab, tabUrl, c.args.name, parsedInput);
          if (pluginHit.handled) return pluginHit.result;
          return browser.tool(c.options.tab, c.args.name, parsedInput);
        });
      },
    });
  }
  cli.command(tools);
}

async function followNetworkLog(
  browser: Browser,
  options: { match: string; since: number; limit: number; timeoutMs: number }
) {
  let cursor = options.since;
  let gap = false;
  let droppedCount = 0;
  let oldestSeq = 0;
  let version = 0;
  const entries: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline && entries.length < options.limit) {
    const page = (await browser.networkLog(options.match, cursor)) as {
      entries: Array<Record<string, unknown>>;
      nextSeq: number; oldestSeq: number; droppedCount: number; gap: boolean; version: number;
    };
    version = page.version;
    oldestSeq = page.oldestSeq;
    droppedCount = page.droppedCount;
    if (page.gap) gap = true;
    for (const entry of page.entries) {
      entries.push(entry);
      if (entries.length >= options.limit) break;
    }
    if (page.nextSeq > cursor) cursor = page.nextSeq;
    if (entries.length >= options.limit) break;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  return { followed: true, version, nextSeq: cursor, oldestSeq, droppedCount, gap, entries };
}

function registerNetworkCommands({ cli, browser, has }: CommandContext): void {
  if (!['net.set', 'net.list', 'net.remove', 'net.log'].some(has)) return;
  const net = Cli.create('net', { description: 'Live browser-wide network rules, mutations, fault injection, and inspection' });
  if (has('net.set')) {
    net.command('rewrite', {
      description: 'Return a mock response from a file on the server',
      options: z.object({ match: z.string().min(1), status: z.number().int().min(200).max(599).default(200), body: z.string(), contentType: z.string().default('application/json'), regex: z.boolean().default(false) }),
      async run(c) {
        return browser.setRule({ match: c.options.match, action: 'mock', status: c.options.status, body: await readFile(c.options.body, 'utf8'), headers: { 'content-type': c.options.contentType }, regex: c.options.regex });
      },
    });
    net.command('mock', {
      description: 'Return a mock response from inline content',
      options: z.object({ match: z.string().min(1), body: z.string(), status: z.number().int().min(200).max(599).default(200), contentType: z.string().default('application/json'), regex: z.boolean().default(false) }),
      run: c => browser.setRule({ match: c.options.match, body: c.options.body, status: c.options.status, headers: { 'content-type': c.options.contentType }, action: 'mock', regex: c.options.regex }),
    });
    net.command('block', {
      description: 'Block matching requests (optionally with a specific net error)',
      options: z.object({ match: z.string().min(1), failError: z.string().optional(), regex: z.boolean().default(false) }),
      run: c => browser.setRule({ ...c.options, action: 'block' }),
    });
    net.command('redirect', {
      description: 'Rewrite matching outgoing URLs',
      options: z.object({ match: z.string().min(1), url: z.string().url(), regex: z.boolean().default(false) }),
      run: c => browser.setRule({ ...c.options, action: 'redirect' }),
    });
    net.command('patch', {
      description: 'Replace text (literal or regex) in matching response bodies',
      options: z.object({ match: z.string().min(1), replace: z.string().min(1), with: z.string(), patchRegex: z.boolean().default(false), regex: z.boolean().default(false) }),
      run: c => browser.setRule({ ...c.options, action: 'patch' }),
    });
    net.command('modify', {
      description: 'Mutate request/response headers, status, or inject latency/faults',
      options: z.object({
        match: z.string().min(1),
        regex: z.boolean().default(false),
        status: z.number().int().min(100).max(599).optional(),
        delayMs: z.number().int().min(0).max(60000).optional(),
        jitterMs: z.number().int().min(0).max(30000).optional(),
        failError: z.string().optional(),
        setRequestHeaders: z.string().optional().describe('JSON object of request headers to set'),
        setResponseHeaders: z.string().optional().describe('JSON object of response headers to set'),
      }),
      run: c => browser.setRule({
        match: c.options.match,
        action: 'modify',
        regex: c.options.regex,
        status: c.options.status,
        delayMs: c.options.delayMs,
        jitterMs: c.options.jitterMs,
        failError: c.options.failError,
        ...(c.options.setRequestHeaders ? { setRequestHeaders: parseJsonObject(c.options.setRequestHeaders, '--set-request-headers') as Record<string, string> } : {}),
        ...(c.options.setResponseHeaders ? { setResponseHeaders: parseJsonObject(c.options.setResponseHeaders, '--set-response-headers') as Record<string, string> } : {}),
      }),
    });
  }
  if (has('net.list')) net.command('list', { description: 'List live rules', run: () => browser.rules() });
  if (has('net.remove')) net.command('remove', { description: 'Remove a rule', options: z.object({ id: z.string().min(1) }), run: c => browser.removeRule(c.options.id) });
  if (has('net.config')) {
    net.command('config', {
      description: 'Configure request/response body capture for network inspection',
      options: z.object({ captureBodies: z.boolean().optional(), maxBodyBytes: z.number().int().min(1024).max(4194304).optional() }),
      run: c => browser.networkConfig(c.options),
    });
  }
  if (has('net.inspect')) {
    net.command('inspect', {
      description: 'Inspect full captured headers and bodies for a network log sequence number',
      options: z.object({ seq: z.number().int().positive() }),
      run: c => browser.inspectNetwork(c.options.seq),
    });
  }
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
      run: c => (c.options.follow ? followNetworkLog(browser, c.options) : browser.networkLog(c.options.match, c.options.since)),
    });
  }
  cli.command(net);
}

function registerClockAndStateCommands({ cli, browser, has }: CommandContext): void {
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
    if (has('profile.clear')) {
      profile.command('clear', {
        description: 'Clear storage for the selected profile (optionally scoped to one origin)',
        options: z.object({
          types: z.string().optional().describe('Comma-separated: cookies,localStorage,indexedDB,cache,serviceWorkers,all'),
          origin: z.string().url().optional().describe('Scope clearing to a single origin URL'),
        }),
        run: c => browser.profileClear(c.options.types ? c.options.types.split(',').map(s => s.trim()).filter(Boolean) : undefined, c.options.origin),
      });
    }
    profile.command('attach', {
      description: 'Inspect or reconnect to a Dub session for a named profile without silently attaching to stock Chrome',
      options: z.object({ name: z.string().min(1).default('Default'), dir: z.string().optional(), socket: z.string().optional() }),
      run: c => attachProfile({ name: c.options.name, dir: c.options.dir, socket: c.options.socket ?? browser.native.socket }),
    });
    cli.command(profile);
  }

  if (['cookies.list', 'cookies.set', 'cookies.delete'].some(has)) {
    const cookies = Cli.create('cookies', { description: 'Direct CookieManager access (including HttpOnly)' });
    if (has('cookies.list')) cookies.command('list', { description: 'List cookies', options: z.object({ url: z.string().optional() }), run: c => browser.cookies(c.options.url) });
    if (has('cookies.set')) {
      cookies.command('set', {
        description: 'Set a cookie',
        options: z.object({
          url: z.string().url(), name: z.string().min(1), value: z.string(),
          domain: z.string().optional(), path: z.string().default('/'),
          secure: z.boolean().optional(), httpOnly: z.boolean().default(false),
          sameSite: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
          expires: z.number().optional(),
        }),
        run: c => browser.setCookie(c.options),
      });
    }
    if (has('cookies.delete')) {
      cookies.command('delete', {
        description: 'Delete cookies matching filter',
        options: z.object({ url: z.string().optional(), name: z.string().optional(), domain: z.string().optional() }),
        run: c => browser.deleteCookies(c.options),
      });
    }
    cli.command(cookies);
  }

  if (has('storage.export') || has('storage.import')) {
    const storage = Cli.create('storage', { description: 'Export and restore tab cookies + WebStorage' });
    if (has('storage.export')) storage.command('export', { description: 'Export cookies, localStorage, and sessionStorage', options: z.object({ tab }), run: c => browser.exportStorage(c.options.tab) });
    if (has('storage.import')) storage.command('import', { description: 'Import storage state JSON into a tab', options: z.object({ tab, state: jsonObject }), run: c => browser.importStorage(c.options.tab, parseJsonObject(c.options.state, '--state')) });
    cli.command(storage);
  }
}

function registerBrowserControlCommands({ cli, browser, has }: CommandContext): void {
  if (['dialog.policy', 'dialog.list', 'dialog.respond'].some(has)) {
    const dialog = Cli.create('dialog', { description: 'Control JavaScript alert/confirm/prompt/beforeunload dialogs' });
    if (has('dialog.policy')) {
      dialog.command('policy', {
        description: 'Get or set JS dialog handling policy',
        options: z.object({ mode: z.enum(['default', 'auto_accept', 'auto_dismiss', 'callback']).optional(), promptText: z.string().optional(), timeoutMs: z.number().int().optional() }),
        run: c => browser.dialogPolicy(c.options.mode ? (c.options as never) : undefined),
      });
    }
    if (has('dialog.list')) dialog.command('list', { description: 'List pending JS dialogs', run: () => browser.dialogs() });
    if (has('dialog.respond')) {
      dialog.command('respond', {
        description: 'Accept or dismiss a pending JS dialog',
        options: z.object({ id: z.string().min(1), accept: z.boolean().default(true), promptText: z.string().optional() }),
        run: c => browser.respondDialog(c.options.id, c.options.accept, c.options.promptText),
      });
    }
    cli.command(dialog);
  }

  if (['downloads.list', 'downloads.config', 'downloads.wait'].some(has)) {
    const downloads = Cli.create('downloads', { description: 'Track and configure browser downloads' });
    if (has('downloads.list')) downloads.command('list', { description: 'List tracked downloads', run: () => browser.downloads() });
    if (has('downloads.config')) downloads.command('config', { description: 'Configure download directory', options: z.object({ directory: z.string().min(1) }), run: c => browser.configureDownloads(c.options.directory) });
    if (has('downloads.wait')) downloads.command('wait', { description: 'Wait for a download to complete', options: z.object({ id: z.string().optional() }), run: c => browser.waitDownload(c.options.id) });
    cli.command(downloads);
  }

  if (has('clipboard.read') || has('clipboard.write')) {
    const clipboard = Cli.create('clipboard', { description: 'Read and write browser clipboard' });
    if (has('clipboard.read')) clipboard.command('read', { description: 'Read clipboard text', run: () => browser.clipboardRead() });
    if (has('clipboard.write')) clipboard.command('write', { description: 'Write clipboard text', options: z.object({ text: z.string() }), run: c => browser.clipboardWrite(c.options.text) });
    cli.command(clipboard);
  }

  if (['scripts.add', 'scripts.remove', 'scripts.list'].some(has)) {
    const scripts = Cli.create('scripts', { description: 'Pre-document TypeScript/JS init scripts (main or isolated world)' });
    if (has('scripts.add')) {
      scripts.command('add', {
        description: 'Inject TypeScript/JS before page scripts run on matching URLs',
        options: z.object({
          match: z.string().default('*'),
          source: z.string().optional(),
          file: z.string().optional(),
          world: z.enum(['main', 'isolated']).default('main'),
          allFrames: z.boolean().default(true),
          typescript: z.boolean().default(true),
        }),
        async run(c) {
          const raw = c.options.file ? await readFile(c.options.file, 'utf8') : c.options.source;
          if (!raw) throw new Error('Provide --source or --file');
          const js = c.options.typescript ? transpileTypeScript(raw) : raw;
          return browser.addScript({ match: c.options.match, source: js, world: c.options.world, allFrames: c.options.allFrames });
        },
      });
    }
    if (has('scripts.remove')) scripts.command('remove', { description: 'Remove an init script', options: z.object({ id: z.string().min(1) }), run: c => browser.removeScript(c.options.id) });
    if (has('scripts.list')) scripts.command('list', { description: 'List active init scripts and exposed functions', run: () => browser.scripts() });
    cli.command(scripts);
  }

  if (has('page.snapshot') || has('net.log')) {
    const trace = Cli.create('trace', { description: 'Export HAR 1.2 + console + snapshot + screenshot bundles' });
    trace.command('export', {
      description: 'Export a reproducible trace bundle for a tab',
      options: z.object({ tab, includeScreenshot: z.boolean().default(false), out: z.string().optional() }),
      async run(c) {
        const bundle = await browser.exportTrace(c.options.tab, { includeScreenshot: c.options.includeScreenshot });
        if (c.options.out) {
          await writeFile(c.options.out, JSON.stringify(bundle, null, 2));
          return { path: c.options.out, entries: bundle.har.log.entries.length, consoleEntries: bundle.console.length };
        }
        return bundle;
      },
    });
    cli.command(trace);
  }
}

function registerCodeJevAgentCommands({ cli, rt }: CommandContext): void {
  const code = Cli.create('code', { description: 'Smithers QuickJS code-mode sandbox (persistent TypeScript REPL with ctx.call to Dub, Jev, and BYO agent)' });
  code.command('eval', {
    description: 'Run TypeScript/JS in a Smithers QuickJS code-mode realm',
    options: z.object({
      code: z.string().optional(),
      file: z.string().optional(),
      realm: z.string().default('default'),
      language: z.enum(['typescript', 'javascript']).default('typescript'),
      timeoutMs: z.number().int().min(500).max(120000).default(30000),
    }),
    async run(c) {
      const src = c.options.file ? await readFile(c.options.file, 'utf8') : c.options.code;
      if (!src) throw new Error('Provide --code or --file');
      return rt.code.evaluate(src, { realmId: c.options.realm, language: c.options.language, timeoutMs: c.options.timeoutMs });
    },
  });
  code.command('flows', { description: 'List all flows callable via ctx.call(...) inside Smithers code mode', run: () => ({ flows: rt.code.listFlows() }) });
  code.command('realms', { description: 'List active persistent code-mode realms', run: () => ({ realms: rt.code.listRealms() }) });
  code.command('reset', { description: 'Reset and dispose a persistent realm', options: z.object({ realm: z.string().default('default') }), run: async c => ({ reset: await rt.code.resetRealm(c.options.realm) }) });
  cli.command(code);

  cli.command('exec', {
    description: 'Execute TypeScript in Smithers QuickJS code mode (shorthand for code eval)',
    options: z.object({
      code: z.string().optional(),
      file: z.string().optional(),
      realm: z.string().default('default'),
      timeoutMs: z.number().int().min(500).max(120000).default(30000),
    }),
    async run(c) {
      const src = c.options.file ? await readFile(c.options.file, 'utf8') : c.options.code;
      if (!src) throw new Error('Provide --code or --file');
      return rt.code.evaluate(src, { realmId: c.options.realm, timeoutMs: c.options.timeoutMs });
    },
  });

  const jev = Cli.create('jev', { description: 'Fast typed decision model (typesafe-ai/jev via @smthrs/model/Evaluator)' });
  jev.command('status', { description: 'Check whether Jev evaluator is configured', run: () => ({ configured: rt.jev.isConfigured, model: rt.jev.modelId }) });
  jev.command('ask', {
    description: 'Ask Jev typed boolean/choice/score questions about a JSON state',
    options: z.object({ state: jsonObject, questions: jsonObject }),
    run: c => rt.jev.ask({
      state: parseJsonObject(c.options.state, '--state'),
      questions: parseJsonObject(c.options.questions, '--questions') as Record<string, JevQuestion>,
    }),
  });
  cli.command(jev);

  const agent = Cli.create('agent', { description: 'Configure or invoke the user BYO agent (CLI, HTTP model/webhook, or MCP turn handoff)' });
  agent.command('status', { description: 'Show active BYO agent adapter configuration', run: () => rt.agent.describe() });
  agent.command('configure', {
    description: 'Configure the BYO agent adapter at runtime',
    options: z.object({
      kind: z.enum(['handoff', 'cli', 'http']),
      command: z.string().optional(),
      args: z.string().optional().describe('Comma-separated CLI arguments'),
      url: z.string().url().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      format: z.enum(['openai', 'anthropic', 'webhook']).optional(),
    }),
    run(c) {
      if (c.options.kind === 'cli') {
        if (!c.options.command) throw new Error('--command is required for kind=cli');
        rt.agent.configure({ kind: 'cli', command: c.options.command, args: c.options.args ? c.options.args.split(',').map(s => s.trim()).filter(Boolean) : [] });
      } else if (c.options.kind === 'http') {
        if (!c.options.url) throw new Error('--url is required for kind=http');
        rt.agent.configure({ kind: 'http', url: c.options.url, apiKey: c.options.apiKey, model: c.options.model, format: c.options.format ?? 'webhook' });
      } else {
        rt.agent.configure({ kind: 'handoff' });
      }
      return rt.agent.describe();
    },
  });
  agent.command('turn', {
    description: 'Trigger a turn on the configured BYO agent',
    options: z.object({ event: z.string().default('manual'), prompt: z.string().min(1), payload: jsonObject, timeoutMs: z.number().int().default(30000) }),
    run: c => rt.agent.runTurn({ event: c.options.event, prompt: c.options.prompt, payload: parseJsonObject(c.options.payload, '--payload'), timeoutMs: c.options.timeoutMs }),
  });
  cli.command(agent);
}

function registerTriggersAndPluginsCommands({ cli, rt }: CommandContext): void {
  const triggers = Cli.create('triggers', { description: 'Register reactive browser hooks that trigger a new LLM turn, Smithers code cell, or Jev decision' });
  triggers.command('register', {
    description: 'Register a reactive trigger on network, dialog, navigation, console, error, download, or WebSocket events',
    options: z.object({
      on: z.enum(['net.request', 'net.response', 'page.dialog', 'page.navigate', 'page.console', 'page.error', 'download', 'ws.message', 'page.exposed']),
      match: z.string().default('*'),
      regex: z.boolean().default(false),
      mode: z.enum(['code', 'agent', 'jev']).default('agent'),
      code: z.string().optional(),
      prompt: z.string().optional(),
      questions: z.string().optional(),
      jevRoutes: z.string().optional(),
      jevRouteQuestion: z.string().optional(),
      realm: z.string().optional(),
      timeoutMs: z.number().int().min(200).max(120000).optional(),
      failOpen: z.boolean().default(true),
      once: z.boolean().default(false),
    }),
    run: c => rt.triggers.register({
      on: c.options.on as TriggerEventType,
      match: c.options.match,
      regex: c.options.regex,
      mode: c.options.mode as TriggerMode,
      code: c.options.code,
      prompt: c.options.prompt,
      questions: c.options.questions ? (parseJsonObject(c.options.questions, '--questions') as Record<string, JevQuestion>) : undefined,
      jevRoutes: c.options.jevRoutes ? (parseJsonObject(c.options.jevRoutes, '--jev-routes') as Record<string, Record<string, unknown> | 'agent' | 'code'>) : undefined,
      jevRouteQuestion: c.options.jevRouteQuestion,
      realmId: c.options.realm,
      timeoutMs: c.options.timeoutMs,
      failOpen: c.options.failOpen,
      once: c.options.once,
    }),
  });
  triggers.command('list', { description: 'List active reactive triggers', run: () => ({ triggers: rt.triggers.list() }) });
  triggers.command('remove', { description: 'Remove a reactive trigger', options: z.object({ id: z.string().min(1) }), run: async c => ({ removed: await rt.triggers.remove(c.options.id) }) });
  triggers.command('pending', { description: 'List paused LLM turns waiting for handoff resolution', run: () => ({ turns: rt.agent.listPendingTurns() }) });
  triggers.command('await', {
    description: 'Block until a reactive trigger fires a new turn for the LLM to inspect and rewrite',
    options: z.object({ timeoutMs: z.number().int().min(100).max(120000).default(30000) }),
    async run(c) {
      const turn = await rt.agent.awaitTurn(c.options.timeoutMs);
      return turn ? { fired: true, turn } : { fired: false, turn: null };
    },
  });
  triggers.command('resolve', {
    description: 'Resolve a paused LLM trigger turn with a rewrite decision JSON or Smithers code-mode TypeScript snippet',
    options: z.object({
      turnId: z.string().min(1),
      decision: z.string().optional(),
      code: z.string().optional(),
    }),
    run(c) {
      const ok = rt.agent.resolveTurn(c.options.turnId, {
        decision: c.options.decision ? parseJsonObject(c.options.decision, '--decision') : undefined,
        code: c.options.code,
      });
      if (!ok) throw new Error(`Unknown or expired turnId: ${c.options.turnId}`);
      return { resolved: true, turnId: c.options.turnId };
    },
  });
  triggers.command('history', { description: 'Inspect recent trigger executions', options: z.object({ limit: z.number().int().min(1).max(500).default(50) }), run: c => ({ history: rt.triggers.getHistory(c.options.limit) }) });
  cli.command(triggers);

  const plugin = Cli.create('plugin', { description: 'Hot-loadable TypeScript code plugins that extend and modify browser behavior' });
  plugin.command('load', {
    description: 'Load a TypeScript or JavaScript Dub plugin file',
    options: z.object({ file: z.string().min(1), watch: z.boolean().default(false) }),
    run: c => rt.plugins.loadFromFile(c.options.file, { watch: c.options.watch }),
  });
  plugin.command('reload', { description: 'Hot-reload a loaded plugin without restarting Chromium', options: z.object({ name: z.string().min(1) }), run: c => rt.plugins.reload(c.options.name) });
  plugin.command('unload', { description: 'Unload a plugin and atomically tear down all its rules/scripts/tools', options: z.object({ name: z.string().min(1) }), run: async c => ({ unloaded: await rt.plugins.unload(c.options.name) }) });
  plugin.command('list', { description: 'List loaded TypeScript plugins', run: () => ({ plugins: rt.plugins.list() }) });
  plugin.command('logs', { description: 'Read logs/errors from loaded plugins', options: z.object({ name: z.string().optional() }), run: c => ({ logs: rt.plugins.logs(c.options.name) }) });
  cli.command(plugin);
}

export function createCommands(browser: Browser, capabilities?: Capabilities, runtime?: DubRuntime) {
  const rt = runtime ?? new DubRuntime(browser);
  const allowed = capabilities?.methods ? new Set(capabilities.methods) : undefined;
  const has = (method: string) => !allowed || allowed.has(method);
  const wrap = <T>(name: string, input: Record<string, unknown>, fn: () => Promise<T>) =>
    rt.plugins.runWithMiddleware(name, input, fn);

  const cli = Cli.create('dub', {
    description: 'DangerouslyUseBrowser: direct control of a forked Chromium with Smithers code mode, Jev, BYO agent triggers, and TS plugins',
    version: '0.1.0-alpha.1',
    mcp: { tools: { discovery: 'direct' } },
  });

  const ctx: CommandContext = { cli, browser, rt, has, wrap };
  registerTabsAndFrames(ctx);
  registerPageCommands(ctx);
  registerEvalAndScreenshotCommands(ctx);
  registerToolsCommands(ctx);
  registerNetworkCommands(ctx);
  registerClockAndStateCommands(ctx);
  registerBrowserControlCommands(ctx);
  registerCodeJevAgentCommands(ctx);
  registerTriggersAndPluginsCommands(ctx);
  return cli;
}

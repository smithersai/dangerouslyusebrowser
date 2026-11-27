import { NativeBridge, type NativeStreamMessage, type NativeSubscription } from './native.js';
import { z } from 'incur';

export const browserInfo = z.object({
  product: z.literal('Dub'), protocol: z.literal(1), chromium: z.string(), revision: z.string(),
  buildId: z.string().optional(), instanceId: z.string().optional(),
  methods: z.array(z.string()), tools: z.array(z.string()).optional(), profile: z.string(),
});
export type BrowserInfo = z.infer<typeof browserInfo>;
export type Tab = { id: number; url: string; title: string; active: boolean; loading: boolean; ephemeral?: boolean };
export type FrameInfo = { frameId: string; parentFrameId?: string; url: string; name: string; isMainFrame: boolean };
export type WaitUntil = 'none' | 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

export type NetworkRule = {
  id?: string;
  match: string;
  action: 'mock' | 'block' | 'redirect' | 'patch' | 'modify' | 'callback';
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
  replace?: string;
  with?: string;
  regex?: boolean;
  patchRegex?: boolean;
  methods?: string[];
  pluginId?: string;
  setRequestHeaders?: Record<string, string>;
  removeRequestHeaders?: string[];
  setResponseHeaders?: Record<string, string>;
  removeResponseHeaders?: string[];
  delayMs?: number;
  jitterMs?: number;
  failError?: string;
  stage?: 'request' | 'response' | 'both';
  timeoutMs?: number;
  failOpen?: boolean;
};

export type SnapshotNode = {
  nodeId?: number;
  role: string;
  tag: string;
  name: string;
  selector: string;
  visible: boolean;
  inShadow: boolean;
  focused: boolean;
  disabled: boolean;
  value?: string;
  checked?: boolean;
  href?: string;
  type?: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type PageSnapshot = {
  frameId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  nodes: SnapshotNode[];
};

export type ConsoleEntry = {
  seq: number;
  timestampMs: number;
  level: string;
  message: string;
  source: string;
  line: number;
  frameId: string;
};

export type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expires?: number;
};

export type EmulateOptions = {
  userAgent?: string;
  colorScheme?: 'dark' | 'light';
  reducedMotion?: 'reduce' | 'no-preference';
  locale?: string;
  timezone?: string;
  randomSeed?: number;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
};

export type ScreenshotOptions = {
  clip?: { x: number; y: number; width: number; height: number };
  format?: 'png' | 'jpeg';
  quality?: number;
};

export class Browser {
  constructor(public readonly native = new NativeBridge()) {}

  async info(): Promise<BrowserInfo> { return browserInfo.parse(await this.native.call('browser.info')); }
  tabs() { return this.native.call<{ tabs: Tab[] }>('tabs.list'); }
  open(url = 'about:blank', opts: { waitUntil?: WaitUntil; ephemeral?: boolean } = {}) {
    return this.native.call<Tab>('tabs.open', { url, ...opts });
  }
  close(tab: number) { return this.native.call('tabs.close', { tab }); }
  activate(tab: number) { return this.native.call<Tab>('tabs.activate', { tab }); }
  navigate(tab: number, url: string, opts: { waitUntil?: WaitUntil } = {}) {
    return this.native.call<Tab>('tabs.navigate', { tab, url, ...opts });
  }
  back(tab: number, opts: { waitUntil?: WaitUntil } = {}) { return this.native.call<Tab>('tabs.back', { tab, ...opts }); }
  forward(tab: number, opts: { waitUntil?: WaitUntil } = {}) { return this.native.call<Tab>('tabs.forward', { tab, ...opts }); }
  reload(tab: number, opts: { ignoreCache?: boolean; waitUntil?: WaitUntil } = {}) {
    return this.native.call<Tab>('tabs.reload', { tab, ...opts });
  }

  frames(tab: number) { return this.native.call<{ tab: number; frames: FrameInfo[] }>('frames.list', { tab }); }
  evaluate<T = unknown>(tab: number, expression: string, opts: { frameId?: string; world?: 'main' | 'isolated' } = {}) {
    return this.native.call<T>('page.evaluate', { tab, expression, ...opts });
  }
  screenshot(tab: number, opts: ScreenshotOptions = {}) {
    return this.native.call<{ mimeType: 'image/png' | 'image/jpeg'; data: string; width?: number; height?: number }>('page.screenshot', { tab, ...opts });
  }
  snapshot(tab: number, opts: { frameId?: string; maxNodes?: number; includeHidden?: boolean } = {}) {
    return this.native.call<PageSnapshot>('page.snapshot', { tab, ...opts });
  }
  console(tab: number, opts: { since?: number; level?: string; clear?: boolean } = {}) {
    return this.native.call<{ tab: number; nextSeq: number; entries: ConsoleEntry[] }>('page.console', { tab, ...opts });
  }
  wait(tab: number, opts: { frameId?: string; selector?: string; text?: string; expression?: string; state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeoutMs?: number }) {
    return this.native.call<{ ok: boolean; detail?: unknown }>('page.wait', { tab, ...opts });
  }
  viewport(tab: number, opts: { width?: number; height?: number } = {}) {
    return this.native.call<{ width: number; height: number; windowWidth?: number; windowHeight?: number }>('page.viewport', { tab, ...opts });
  }
  emulate(tab: number, opts: EmulateOptions) {
    return this.native.call<{ emulated: boolean }>('page.emulate', { tab, ...opts });
  }

  tools(tab: number) { return this.native.call<{ tools: Array<Record<string, unknown>> }>('tools.list', { tab }); }
  tool(tab: number, name: string, input: Record<string, unknown> = {}) { return this.native.call('tools.call', { tab, name, input }); }

  clipboardRead() { return this.native.call<{ text: string }>('clipboard.read'); }
  clipboardWrite(text: string) { return this.native.call<{ written: boolean; length: number }>('clipboard.write', { text }); }

  dialogPolicy(opts?: { mode: 'default' | 'auto_accept' | 'auto_dismiss' | 'callback'; promptText?: string; timeoutMs?: number }) {
    return this.native.call<{ mode: string; promptText: string; timeoutMs: number }>('dialog.policy', opts ?? {});
  }
  dialogs() { return this.native.call<{ policy: Record<string, unknown>; dialogs: Array<Record<string, unknown>> }>('dialog.list'); }
  respondDialog(id: string, accept: boolean, promptText?: string) {
    return this.native.call('dialog.respond', { id, accept, ...(promptText !== undefined ? { promptText } : {}) });
  }

  downloads() { return this.native.call<{ downloads: Array<Record<string, unknown>> }>('downloads.list'); }
  configureDownloads(directory: string) { return this.native.call<{ directory: string }>('downloads.config', { directory }); }
  waitDownload(id?: string) { return this.native.call<Record<string, unknown>>('downloads.wait', id ? { id } : {}); }

  cookies(url?: string) { return this.native.call<{ cookies: CookieRecord[] }>('cookies.list', url ? { url } : {}); }
  setCookie(cookie: { url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }) {
    return this.native.call<{ set: boolean }>('cookies.set', cookie);
  }
  deleteCookies(filter: { url?: string; name?: string; domain?: string } = {}) {
    return this.native.call<{ deleted: number }>('cookies.delete', filter);
  }
  exportStorage(tab: number) {
    return this.native.call<{ origin?: string; localStorage?: Record<string, string>; sessionStorage?: Record<string, string>; cookies: CookieRecord[] }>('storage.export', { tab });
  }
  importStorage(tab: number, state: Record<string, unknown>) {
    return this.native.call<{ imported: boolean }>('storage.import', { tab, state });
  }

  profileInfo() { return this.native.call<{ path: string; name: string; instanceId: string; offTheRecord: boolean }>('profile.info'); }
  profileClear(types?: string[], origin?: string) {
    return this.native.call<{ cleared: boolean; profile: string; mask: number }>('profile.clear', {
      ...(types ? { types } : {}),
      ...(origin ? { origin } : {}),
    });
  }

  setRule(rule: NetworkRule) { return this.native.call('net.set', { ...rule }); }
  rules() { return this.native.call<{ version: number; rules: Array<Record<string, unknown>> }>('net.list'); }
  removeRule(id: string) { return this.native.call('net.remove', { id }); }
  removeRulesByPlugin(pluginId: string) { return this.native.call('net.remove_by_plugin', { pluginId }); }
  networkConfig(opts: { captureBodies?: boolean; maxBodyBytes?: number }) {
    return this.native.call<{ captureBodies: boolean; maxBodyBytes: number }>('net.config', opts);
  }
  networkLog(match = '', since = 0) { return this.native.call('net.log', { match, since }); }
  inspectNetwork(seq: number) { return this.native.call<Record<string, unknown>>('net.inspect', { seq }); }

  addScript(opts: { id?: string; match?: string; source: string; world?: 'main' | 'isolated'; allFrames?: boolean; pluginId?: string }) {
    return this.native.call<{ id: string; match: string; world: string; allFrames: boolean }>('scripts.add', opts);
  }
  removeScript(id: string) { return this.native.call('scripts.remove', { id }); }
  scripts() { return this.native.call<{ scripts: Array<Record<string, unknown>>; exposedFunctions: string[] }>('scripts.list'); }
  exposeFunction(name: string, pluginId?: string) {
    return this.native.call<{ exposed: boolean; name: string }>('scripts.expose', { name, ...(pluginId ? { pluginId } : {}) });
  }
  unexposeFunction(name: string) { return this.native.call('scripts.unexpose', { name }); }
  removeScriptsByPlugin(pluginId: string) { return this.native.call('scripts.remove_by_plugin', { pluginId }); }

  subscribe(handlers: { events?: string[]; onMessage: (msg: NativeStreamMessage) => void; onClose?: (error?: string) => void }): Promise<NativeSubscription> {
    return this.native.subscribe(handlers);
  }
  respondCallback(callbackId: string, decision: Record<string, unknown>) {
    return this.native.call<{ ok: boolean; callbackId: string }>('callback.respond', { callbackId, decision });
  }
  pendingCallbacks() {
    return this.native.call<{ callbacks: Array<Record<string, unknown>> }>('callbacks.list');
  }

  freeze(tab: number, at: string) { return this.native.call('clock.freeze', { tab, at }); }
  advance(tab: number, milliseconds: number) { return this.native.call('clock.advance', { tab, milliseconds }); }
  step(tab: number, frames = 1) { return this.native.call('clock.step', { tab, frames }); }
  resume(tab: number) { return this.native.call('clock.resume', { tab }); }

  async exportTrace(tab: number, opts: { includeScreenshot?: boolean } = {}) {
    const [info, tabsRes, snap, cons, net] = await Promise.all([
      this.info(),
      this.tabs(),
      this.snapshot(tab).catch(() => null),
      this.console(tab).catch(() => ({ entries: [] })),
      this.networkLog('', 0).catch(() => ({ entries: [] })),
    ]);
    const shot = opts.includeScreenshot ? await this.screenshot(tab).catch(() => null) : null;
    const netEntries = ((net as { entries?: Array<Record<string, unknown>> }).entries ?? []);
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Dub', version: info.chromium },
        entries: netEntries.map(e => ({
          startedDateTime: new Date(Number(e.timestampMs ?? Date.now())).toISOString(),
          request: { method: String(e.method ?? 'GET'), url: String(e.url ?? ''), httpVersion: 'HTTP/1.1', headers: [], queryString: [], headersSize: -1, bodySize: -1 },
          response: { status: Number(e.status ?? 0), statusText: '', httpVersion: 'HTTP/1.1', headers: [], content: { size: 0, mimeType: '' }, redirectURL: String(e.finalUrl ?? ''), headersSize: -1, bodySize: -1 },
          _dub: { seq: e.seq, action: e.action, ruleId: e.ruleId, patched: e.patched, error: e.error },
        })),
      },
    };
    return {
      generatedAt: new Date().toISOString(),
      browser: info,
      tab: tabsRes.tabs.find(t => t.id === tab) ?? null,
      snapshot: snap,
      console: (cons as { entries?: ConsoleEntry[] }).entries ?? [],
      har,
      ...(shot ? { screenshot: shot } : {}),
    };
  }
}

export function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('Use a duration such as 250ms, 2s, 5m, 1h or 31d');
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const milliseconds = Number(match[1]) * scale[match[2]!]!;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error('Duration must be a positive whole number of milliseconds');
  return milliseconds;
}

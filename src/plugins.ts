import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { transform } from 'sucrase';
import type { Browser, NetworkRule } from './browser.js';
import type { JevAskInput, JevAskResult, JevClient } from './jev.js';
import type { AgentBridge, AgentTurnResponse } from './agent-bridge.js';
import type { CodeEvalOptions, CodeEvalResult, SmithersCodeRuntime } from './smithers-runtime.js';
import type { TriggerEngine, TriggerRecord, TriggerSpec } from './triggers.js';

export type NetworkCallbackRequest = {
  stage: 'request' | 'response';
  ruleId: string;
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  json: <T = unknown>() => T | undefined;
};

export type NetworkCallbackDecision =
  | { action: 'continue' }
  | { action: 'block'; failError?: string }
  | { action: 'mock'; status?: number; headers?: Record<string, string>; body?: string; json?: unknown }
  | { action: 'modify'; url?: string; status?: number; headers?: Record<string, string>; requestHeaders?: Record<string, string>; body?: string; json?: unknown };

export type PluginToolDef = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run: (input: Record<string, unknown>, ctx: { browser: Browser }) => Promise<unknown> | unknown;
};

export type SyntheticPageToolDef = {
  match: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run: (input: Record<string, unknown>, ctx: { tab: number; browser: Browser }) => Promise<unknown> | unknown;
};

export type CommandMiddleware = (
  call: { name: string; input: Record<string, unknown> },
  next: () => Promise<unknown>
) => Promise<unknown>;

export type PluginContext = {
  readonly pluginId: string;
  readonly browser: Browser;
  readonly net: {
    handle: (
      match: string,
      handler: (req: NetworkCallbackRequest) => Promise<NetworkCallbackDecision> | NetworkCallbackDecision,
      opts?: { stage?: 'request' | 'response' | 'both'; methods?: string[]; regex?: boolean; timeoutMs?: number; failOpen?: boolean }
    ) => Promise<string>;
    setRule: (rule: Omit<NetworkRule, 'pluginId'>) => Promise<unknown>;
    mock: (match: string, opts: { status?: number; body?: string; json?: unknown; headers?: Record<string, string> }) => Promise<unknown>;
    block: (match: string, failError?: string) => Promise<unknown>;
    patch: (match: string, replace: string, withText: string, regex?: boolean) => Promise<unknown>;
  };
  readonly triggers: {
    register: (spec: Omit<TriggerSpec, 'pluginId'>) => Promise<TriggerRecord>;
  };
  on: (event: string, fn: (data: Record<string, unknown>) => void | Promise<void>) => string;
  use: (middleware: CommandMiddleware) => void;
  tool: (def: PluginToolDef) => void;
  pageTool: (def: SyntheticPageToolDef) => void;
  addInitScript: (
    match: string,
    sourceOrFn: string | ((...args: unknown[]) => unknown),
    opts?: { world?: 'main' | 'isolated'; allFrames?: boolean; typescript?: boolean }
  ) => Promise<{ id: string }>;
  exposeFunction: (name: string, fn: (...args: unknown[]) => Promise<unknown> | unknown) => Promise<void>;
  jev: (input: JevAskInput) => Promise<JevAskResult>;
  agent: (input: { event?: string; prompt: string; payload?: Record<string, unknown>; timeoutMs?: number }) => Promise<AgentTurnResponse>;
  code: (tsCode: string, opts?: CodeEvalOptions) => Promise<CodeEvalResult>;
  log: (...args: unknown[]) => void;
};

export type DubPlugin = {
  name: string;
  description?: string;
  setup: (dub: PluginContext) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
};

export function definePlugin(plugin: DubPlugin): DubPlugin {
  return plugin;
}

type LoadedPlugin = {
  name: string;
  description?: string;
  filePath?: string;
  loadedAt: number;
  cleanup?: () => Promise<void> | void;
  watcher?: FSWatcher;
  tools: string[];
  pageTools: string[];
  exposedFunctions: string[];
  logs: Array<{ timestamp: number; level: 'info' | 'error'; message: string }>;
};

function matchesUrlWildcard(url: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (!pattern.includes('*')) return url.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

/**
 * Transpiles TypeScript syntax cleanly using Smithers' bundled `sucrase` transform
 * so browser-side init scripts and TS plugin files work on any Node 22+ installation.
 */
export function transpileTypeScript(source: string): string {
  return transform(source, { transforms: ['typescript'], disableESTransforms: true }).code;
}

/**
 * Manages hot-loadable TypeScript code plugins with scoped teardown,
 * synthetic WebMCP polyfills, dynamic MCP tools, middleware, and live Chromium hooks.
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private customTools = new Map<string, { pluginId: string; def: PluginToolDef }>();
  private syntheticPageTools = new Map<string, { pluginId: string; def: SyntheticPageToolDef }>();
  private middlewares: Array<{ pluginId: string; fn: CommandMiddleware }> = [];
  private tempDir = join(tmpdir(), `dub-plugins-${process.pid}`);

  constructor(
    private readonly browser: Browser,
    private readonly triggers: TriggerEngine,
    private readonly codeRuntime: SmithersCodeRuntime,
    private readonly jev: JevClient,
    private readonly agent: AgentBridge
  ) {}

  async loadFromFile(filePath: string, opts: { watch?: boolean } = {}): Promise<{ name: string; filePath: string; tools: string[]; pageTools: string[] }> {
    const abs = resolve(filePath);
    const raw = await readFile(abs, 'utf8');
    let importUrl: string;
    if (abs.endsWith('.ts') || abs.endsWith('.mts')) {
      const js = transpileTypeScript(raw);
      await mkdir(this.tempDir, { recursive: true });
      const outPath = join(this.tempDir, `${basename(abs, '.ts')}-${Date.now()}-${randomUUID().slice(0, 6)}.mjs`);
      await writeFile(outPath, js, 'utf8');
      importUrl = pathToFileURL(outPath).href;
    } else {
      importUrl = `${pathToFileURL(abs).href}?t=${Date.now()}`;
    }

    const mod = (await import(importUrl)) as { default?: DubPlugin; plugin?: DubPlugin };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin || typeof plugin.name !== 'string' || typeof plugin.setup !== 'function') {
      throw new Error(`Plugin file ${abs} must default-export definePlugin({ name, setup(dub) { ... } })`);
    }

    const loaded = await this.load(plugin, abs);
    if (opts.watch) {
      const rec = this.plugins.get(loaded.name);
      if (rec) {
        let debounce: ReturnType<typeof setTimeout> | undefined;
        rec.watcher = watch(abs, () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            void this.reload(loaded.name).catch(err => this.appendLog(loaded.name, 'error', String(err)));
          }, 150);
        });
      }
    }
    return { ...loaded, filePath: abs };
  }

  private buildNetApi(pluginName: string): PluginContext['net'] {
    return {
      handle: (match, handler, opts = {}) =>
        this.triggers.registerDirectCallback({
          kind: opts.stage === 'response' ? 'net.response' : 'net.request',
          match,
          regex: opts.regex,
          methods: opts.methods,
          stage: opts.stage ?? 'request',
          timeoutMs: opts.timeoutMs,
          failOpen: opts.failOpen,
          pluginId: pluginName,
          handler: async payload => {
            const req: NetworkCallbackRequest = {
              stage: (payload.stage as 'request' | 'response') ?? 'request',
              ruleId: String(payload.ruleId ?? ''),
              url: String(payload.url ?? ''),
              method: String(payload.method ?? 'GET'),
              status: Number(payload.status ?? 0),
              requestHeaders: (payload.requestHeaders as Record<string, string>) ?? {},
              responseHeaders: (payload.responseHeaders as Record<string, string>) ?? {},
              body: String(payload.body ?? ''),
              bodyTruncated: Boolean(payload.bodyTruncated),
              json: <T = unknown>() => {
                try { return JSON.parse(String(payload.body ?? '')) as T; } catch { return undefined; }
              },
            };
            const dec = await handler(req);
            if (dec.action === 'mock' || dec.action === 'modify') {
              const headers = { ...(dec.headers ?? {}) };
              let body = dec.body;
              if (dec.json !== undefined) {
                body = JSON.stringify(dec.json);
                if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
                  headers['content-type'] = 'application/json';
                }
              }
              return { ...dec, headers, ...(body !== undefined ? { body } : {}) };
            }
            return dec;
          },
        }),
      setRule: rule => this.browser.setRule({ ...rule, pluginId: pluginName }),
      mock: (match, opts) => {
        const headers = { ...(opts.headers ?? {}) };
        const body = opts.json !== undefined ? JSON.stringify(opts.json) : (opts.body ?? '');
        if (opts.json !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json';
        }
        return this.browser.setRule({
          match,
          action: 'mock',
          status: opts.status ?? 200,
          body,
          headers,
          pluginId: pluginName,
        });
      },
      block: (match, failError) =>
        this.browser.setRule({ match, action: 'block', failError, pluginId: pluginName }),
      patch: (match, replace, withText, regex = false) =>
        this.browser.setRule({ match, action: 'patch', replace, with: withText, patchRegex: regex, pluginId: pluginName }),
    };
  }

  private buildPluginContext(plugin: DubPlugin, rec: LoadedPlugin): PluginContext {
    return {
      pluginId: plugin.name,
      browser: this.browser,
      net: this.buildNetApi(plugin.name),
      triggers: {
        register: spec => this.triggers.register({ ...spec, pluginId: plugin.name }),
      },
      on: (event, fn) => this.triggers.onEvent(event, fn, plugin.name),
      use: fn => { this.middlewares.push({ pluginId: plugin.name, fn }); },
      tool: def => {
        this.customTools.set(def.name, { pluginId: plugin.name, def });
        rec.tools.push(def.name);
        this.codeRuntime.registerFlow({
          name: `plugin.${def.name}`,
          description: def.description,
          handler: input => Promise.resolve(def.run(input, { browser: this.browser })),
        });
      },
      pageTool: def => {
        const key = `${plugin.name}:${def.name}`;
        this.syntheticPageTools.set(key, { pluginId: plugin.name, def });
        rec.pageTools.push(`page.${def.name}`);
      },
      addInitScript: async (match, sourceOrFn, opts = {}) => {
        let src = typeof sourceOrFn === 'function' ? `(${sourceOrFn.toString()})();` : sourceOrFn;
        if (opts.typescript !== false && typeof sourceOrFn === 'string') {
          src = transpileTypeScript(src);
        }
        return this.browser.addScript({
          match,
          source: src,
          world: opts.world ?? 'main',
          allFrames: opts.allFrames ?? true,
          pluginId: plugin.name,
        });
      },
      exposeFunction: async (name, fn) => {
        rec.exposedFunctions.push(name);
        await this.browser.exposeFunction(name, plugin.name);
        await this.triggers.registerDirectCallback({
          kind: 'page.exposed',
          match: name,
          pluginId: plugin.name,
          handler: async payload => {
            const args = Array.isArray(payload.args) ? payload.args : [];
            const res = await fn(...args);
            return { result: res === undefined ? null : res };
          },
        });
      },
      jev: input => this.jev.ask(input),
      agent: input =>
        this.agent.runTurn({
          event: input.event ?? `plugin.${plugin.name}`,
          prompt: input.prompt,
          payload: input.payload ?? {},
          timeoutMs: input.timeoutMs,
        }),
      code: (tsCode, opts) => this.codeRuntime.evaluate(tsCode, { realmId: `plugin-${plugin.name}`, ...opts }),
      log: (...args) => this.appendLog(plugin.name, 'info', args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    };
  }

  async load(plugin: DubPlugin, filePath?: string): Promise<{ name: string; tools: string[]; pageTools: string[] }> {
    if (this.plugins.has(plugin.name)) {
      await this.unload(plugin.name);
    }

    const rec: LoadedPlugin = {
      name: plugin.name,
      description: plugin.description,
      filePath,
      loadedAt: Date.now(),
      tools: [],
      pageTools: [],
      exposedFunctions: [],
      logs: [],
    };
    this.plugins.set(plugin.name, rec);

    const ctx = this.buildPluginContext(plugin, rec);

    try {
      const cleanup = await plugin.setup(ctx);
      if (typeof cleanup === 'function') rec.cleanup = cleanup;
    } catch (err) {
      this.appendLog(plugin.name, 'error', err instanceof Error ? err.stack ?? err.message : String(err));
      await this.unload(plugin.name).catch(() => {});
      throw err;
    }

    return { name: plugin.name, tools: [...rec.tools], pageTools: [...rec.pageTools] };
  }

  async reload(name: string) {
    const rec = this.plugins.get(name);
    if (!rec?.filePath) throw new Error(`Plugin "${name}" cannot be reloaded because it was not loaded from a file`);
    const watchEnabled = Boolean(rec.watcher);
    const filePath = rec.filePath;
    await this.unload(name);
    return this.loadFromFile(filePath, { watch: watchEnabled });
  }

  async unload(name: string): Promise<boolean> {
    const rec = this.plugins.get(name);
    if (!rec) return false;
    rec.watcher?.close();
    this.plugins.delete(name);
    if (rec.cleanup) {
      try { await rec.cleanup(); } catch {}
    }
    for (const t of rec.tools) {
      this.customTools.delete(t);
      this.codeRuntime.unregisterFlow(`plugin.${t}`);
    }
    for (const [k, v] of [...this.syntheticPageTools]) {
      if (v.pluginId === name) this.syntheticPageTools.delete(k);
    }
    this.middlewares = this.middlewares.filter(m => m.pluginId !== name);
    await this.triggers.removeByPlugin(name);
    await this.browser.removeRulesByPlugin(name).catch(() => {});
    await this.browser.removeScriptsByPlugin(name).catch(() => {});
    return true;
  }

  list() {
    return [...this.plugins.values()].map(p => ({
      name: p.name,
      description: p.description,
      filePath: p.filePath,
      loadedAt: p.loadedAt,
      tools: p.tools,
      pageTools: p.pageTools,
      exposedFunctions: p.exposedFunctions,
      logCount: p.logs.length,
    }));
  }

  logs(name?: string) {
    if (name) return this.plugins.get(name)?.logs ?? [];
    return [...this.plugins.values()].flatMap(p => p.logs.map(l => ({ plugin: p.name, ...l })));
  }

  listCustomTools() {
    return [...this.customTools.values()].map(({ pluginId, def }) => ({
      name: def.name,
      pluginId,
      source: 'plugin',
      description: def.description,
      inputSchema: def.inputSchema ?? { type: 'object', additionalProperties: true },
    }));
  }

  listSyntheticPageToolsForUrl(url: string) {
    const out: Array<Record<string, unknown>> = [];
    for (const { pluginId, def } of this.syntheticPageTools.values()) {
      if (matchesUrlWildcard(url, def.match)) {
        out.push({
          name: `page.${def.name}`,
          rawName: def.name,
          source: 'plugin-webmcp',
          pluginId,
          description: def.description,
          inputSchema: def.inputSchema ?? { type: 'object', additionalProperties: true },
        });
      }
    }
    return out;
  }

  async invokeCustomOrSyntheticTool(
    tab: number,
    tabUrl: string,
    name: string,
    input: Record<string, unknown>
  ): Promise<{ handled: boolean; result?: unknown }> {
    const custom = this.customTools.get(name);
    if (custom) {
      const result = await custom.def.run(input, { browser: this.browser });
      return { handled: true, result };
    }
    if (name.startsWith('page.')) {
      const raw = name.slice(5);
      for (const { def } of this.syntheticPageTools.values()) {
        if (def.name === raw && matchesUrlWildcard(tabUrl, def.match)) {
          const result = await def.run(input, { tab, browser: this.browser });
          return { handled: true, result };
        }
      }
    }
    return { handled: false };
  }

  async runWithMiddleware<T>(name: string, input: Record<string, unknown>, execute: () => Promise<T>): Promise<T> {
    let idx = 0;
    const chain = [...this.middlewares];
    const dispatch = async (): Promise<unknown> => {
      if (idx >= chain.length) return execute();
      const mw = chain[idx++]!;
      return mw.fn({ name, input }, dispatch);
    };
    return (await dispatch()) as T;
  }

  private appendLog(pluginId: string, level: 'info' | 'error', message: string) {
    const rec = this.plugins.get(pluginId);
    if (!rec) return;
    rec.logs.push({ timestamp: Date.now(), level, message });
    if (rec.logs.length > 200) rec.logs.shift();
  }

  async closeAll() {
    for (const name of [...this.plugins.keys()]) {
      await this.unload(name);
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { Browser } from './browser.js';
import type { NativeStreamMessage, NativeSubscription } from './native.js';
import type { JevClient, JevQuestion } from './jev.js';
import type { AgentBridge } from './agent-bridge.js';
import type { SmithersCodeRuntime } from './smithers-runtime.js';

export type TriggerEventType =
  | 'net.request'
  | 'net.response'
  | 'page.dialog'
  | 'page.navigate'
  | 'page.console'
  | 'page.error'
  | 'download'
  | 'ws.message'
  | 'page.exposed';

export type TriggerMode = 'code' | 'agent' | 'jev';

export type TriggerSpec = {
  id?: string;
  on: TriggerEventType;
  /** Wildcard or substring matcher against URL / message / function name. */
  match?: string;
  regex?: boolean;
  methods?: string[];
  mode: TriggerMode;
  /** TypeScript code for mode='code' (runs in Smithers QuickJS realm with `event` and `ctx.call`). */
  code?: string;
  /** Instructions for the BYO agent when mode='agent' (or when Jev escalates to agent). */
  prompt?: string;
  /** Typed questions for mode='jev' (runs against @smthrs/model/Evaluator). */
  questions?: Record<string, JevQuestion>;
  /** For mode='jev': map answer key/value -> decision, or escalate to 'agent' / 'code'. */
  jevRoutes?: Record<string, Record<string, unknown> | 'agent' | 'code'>;
  /** Which Jev question id selects the route in jevRoutes (default: first question). */
  jevRouteQuestion?: string;
  /** Optional persistent QuickJS realmId so trigger invocations share state. */
  realmId?: string;
  timeoutMs?: number;
  failOpen?: boolean;
  once?: boolean;
  pluginId?: string;
};

export type TriggerRecord = TriggerSpec & {
  id: string;
  createdAt: number;
  fires: number;
  networkRuleId?: string;
  wsScriptId?: string;
};

export type TriggerHistoryEntry = {
  id: string;
  triggerId: string;
  event: string;
  mode: TriggerMode;
  timestamp: number;
  durationMs: number;
  ok: boolean;
  decision?: Record<string, unknown>;
  error?: string;
};

type DirectCallbackHandler = {
  id: string;
  kind: string;
  match?: string;
  pluginId?: string;
  networkRuleId?: string;
  handler: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function matchesPattern(text: string, pattern?: string, isRegex = false): boolean {
  if (!pattern || pattern === '*') return true;
  if (isRegex) {
    try { return new RegExp(pattern).test(text); } catch { return false; }
  }
  if (!pattern.includes('*')) return text.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(text);
}

const WS_BRIDGE_INIT_SCRIPT = `(() => {
  if (window.__dubWsHooked) return;
  window.__dubWsHooked = true;
  const OrigWS = window.WebSocket;
  window.WebSocket = function DubWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      if (typeof window.__dubWsEvent === 'function') {
        window.__dubWsEvent({ direction: 'send', url: String(url), data: typeof data === 'string' ? data : '[binary]' })
          .then((res) => {
            if (res && res.action === 'block') return;
            if (res && typeof res.data === 'string') return origSend(res.data);
            return origSend(data);
          }).catch(() => origSend(data));
        return;
      }
      return origSend(data);
    };
    ws.addEventListener('message', (ev) => {
      if (typeof window.__dubWsEvent === 'function') {
        window.__dubWsEvent({ direction: 'receive', url: String(url), data: typeof ev.data === 'string' ? ev.data : '[binary]' }).catch(() => {});
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  window.WebSocket.CLOSED = OrigWS.CLOSED;
})();`;

/**
 * Reactive Trigger & Event Engine: subscribes to Chromium's persistent push stream
 * and routes events/callbacks to Smithers QuickJS code-mode cells, Jev decisions,
 * BYO Agent turns, or registered TypeScript plugin handlers.
 */
export class TriggerEngine {
  private triggers = new Map<string, TriggerRecord>();
  private directCallbacks = new Map<string, DirectCallbackHandler>();
  private eventListeners = new Map<string, Set<{ id: string; pluginId?: string; fn: (ev: Record<string, unknown>) => void | Promise<void> }>>();
  private history: TriggerHistoryEntry[] = [];
  private subscription?: NativeSubscription;
  private subscribing?: Promise<void>;
  private wsHookInstalled = false;

  constructor(
    private readonly browser: Browser,
    private readonly codeRuntime: SmithersCodeRuntime,
    private readonly jev: JevClient,
    private readonly agent: AgentBridge
  ) {
    // Expose trigger registration to QuickJS code-mode cells as well!
    this.codeRuntime.registerFlow({
      name: 'dub.triggers.register',
      description: 'Register a reactive browser trigger (code, agent, or jev mode): { on, match?, mode, code?, prompt?, questions?, jevRoutes?, timeoutMs?, once? }',
      handler: i => this.register(i as unknown as TriggerSpec),
    });
    this.codeRuntime.registerFlow({
      name: 'dub.triggers.list',
      description: 'List active reactive browser triggers',
      handler: async () => ({ triggers: this.list() }),
    });
    this.codeRuntime.registerFlow({
      name: 'dub.triggers.remove',
      description: 'Remove a reactive trigger: { id }',
      handler: async i => ({ removed: await this.remove(String(i.id)) }),
    });
  }

  async ensureSubscribed(): Promise<void> {
    if (this.subscription) return;
    if (this.subscribing) return this.subscribing;
    this.subscribing = (async () => {
      try {
        this.subscription = await this.browser.subscribe({
          onMessage: msg => { void this.handleStreamMessage(msg); },
          onClose: () => { this.subscription = undefined; },
        });
      } catch {
        // Fixture or older fork without events.subscribe.
      } finally {
        this.subscribing = undefined;
      }
    })();
    return this.subscribing;
  }

  onEvent(event: string, fn: (data: Record<string, unknown>) => void | Promise<void>, pluginId?: string): string {
    void this.ensureSubscribed();
    const id = `ev-${randomUUID().slice(0, 8)}`;
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add({ id, pluginId, fn });
    return id;
  }

  offByPlugin(pluginId: string) {
    for (const set of this.eventListeners.values()) {
      for (const entry of [...set]) {
        if (entry.pluginId === pluginId) set.delete(entry);
      }
    }
  }

  async registerDirectCallback(opts: {
    kind: 'net.request' | 'net.response' | 'dialog' | 'page.exposed';
    match?: string;
    regex?: boolean;
    methods?: string[];
    stage?: 'request' | 'response' | 'both';
    timeoutMs?: number;
    failOpen?: boolean;
    pluginId?: string;
    handler: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }): Promise<string> {
    await this.ensureSubscribed();
    const id = `dcb-${randomUUID().slice(0, 8)}`;
    let networkRuleId: string | undefined;
    if (opts.kind === 'net.request' || opts.kind === 'net.response') {
      networkRuleId = `dub-cb-${id}`;
      await this.browser.setRule({
        id: networkRuleId,
        match: opts.match ?? '*',
        action: 'callback',
        regex: opts.regex,
        methods: opts.methods,
        stage: opts.stage ?? (opts.kind === 'net.response' ? 'response' : 'request'),
        timeoutMs: opts.timeoutMs ?? 15000,
        failOpen: opts.failOpen ?? true,
        pluginId: opts.pluginId,
      });
    } else if (opts.kind === 'dialog') {
      await this.browser.dialogPolicy({ mode: 'callback', timeoutMs: opts.timeoutMs ?? 15000 });
    }
    this.directCallbacks.set(id, {
      id,
      kind: opts.kind,
      match: opts.match,
      pluginId: opts.pluginId,
      networkRuleId,
      handler: opts.handler,
    });
    return id;
  }

  async removeDirectCallbacksByPlugin(pluginId: string) {
    for (const [id, entry] of [...this.directCallbacks]) {
      if (entry.pluginId !== pluginId) continue;
      this.directCallbacks.delete(id);
      if (entry.networkRuleId) {
        await this.browser.removeRule(entry.networkRuleId).catch(() => {});
      }
    }
  }

  async register(spec: TriggerSpec): Promise<TriggerRecord> {
    if (spec.mode === 'code' && !spec.code?.trim()) {
      throw new Error('Trigger with mode="code" requires non-empty TypeScript/JS code');
    }
    if (spec.mode === 'jev' && (!spec.questions || Object.keys(spec.questions).length === 0)) {
      throw new Error('Trigger with mode="jev" requires at least one Jev question');
    }
    await this.ensureSubscribed();

    const id = spec.id ?? `trig-${randomUUID().slice(0, 8)}`;
    const record: TriggerRecord = {
      ...spec,
      id,
      timeoutMs: spec.timeoutMs ?? (spec.mode === 'agent' ? 30000 : 15000),
      failOpen: spec.failOpen ?? true,
      createdAt: Date.now(),
      fires: 0,
    };

    if (spec.on === 'net.request' || spec.on === 'net.response') {
      record.networkRuleId = `dub-trig-${id}`;
      await this.browser.setRule({
        id: record.networkRuleId,
        match: spec.match ?? '*',
        action: 'callback',
        regex: spec.regex,
        methods: spec.methods,
        stage: spec.on === 'net.response' ? 'response' : 'request',
        timeoutMs: record.timeoutMs,
        failOpen: record.failOpen,
        pluginId: spec.pluginId,
      });
    } else if (spec.on === 'page.dialog') {
      await this.browser.dialogPolicy({ mode: 'callback', timeoutMs: record.timeoutMs });
    } else if (spec.on === 'ws.message' && !this.wsHookInstalled) {
      this.wsHookInstalled = true;
      await this.browser.exposeFunction('__dubWsEvent', '__dub_internal').catch(() => {});
      const added = await this.browser.addScript({
        id: '__dub_ws_bridge',
        match: '*',
        source: WS_BRIDGE_INIT_SCRIPT,
        world: 'main',
        allFrames: true,
        pluginId: '__dub_internal',
      }).catch(() => undefined);
      record.wsScriptId = added?.id;
    }

    this.triggers.set(id, record);
    return record;
  }

  list(): TriggerRecord[] {
    return [...this.triggers.values()];
  }

  getHistory(limit = 50): TriggerHistoryEntry[] {
    return this.history.slice(-limit);
  }

  async remove(id: string): Promise<boolean> {
    const rec = this.triggers.get(id);
    if (!rec) return false;
    this.triggers.delete(id);
    if (rec.networkRuleId) {
      await this.browser.removeRule(rec.networkRuleId).catch(() => {});
    }
    return true;
  }

  async removeByPlugin(pluginId: string): Promise<number> {
    let count = 0;
    for (const rec of [...this.triggers.values()]) {
      if (rec.pluginId === pluginId) {
        await this.remove(rec.id);
        count++;
      }
    }
    await this.removeDirectCallbacksByPlugin(pluginId);
    this.offByPlugin(pluginId);
    return count;
  }

  /** Public entry point so unit tests can also inject synthetic native stream frames cleanly. */
  async handleStreamMessage(msg: NativeStreamMessage): Promise<void> {
    if (msg.type === 'event') {
      const listeners = [
        ...(this.eventListeners.get(msg.event) ?? []),
        ...(this.eventListeners.get('*') ?? []),
      ];
      for (const l of listeners) {
        try { await l.fn(msg.data); } catch {}
      }
      // Dispatch non-blocking reactive triggers for fire-and-forget events.
      for (const trig of [...this.triggers.values()]) {
        if (!this.matchesEventTrigger(trig, msg.event, msg.data)) continue;
        void this.executeTrigger(trig, msg.event, msg.data).catch(() => {});
      }
      return;
    }

    if (msg.type === 'callback') {
      await this.handleCallbackMessage(msg);
    }
  }

  private matchesEventTrigger(trig: TriggerRecord, eventName: string, data: Record<string, unknown>): boolean {
    if (trig.on === 'page.navigate' && eventName === 'tab.navigated') {
      return matchesPattern(String(data.url ?? ''), trig.match, trig.regex);
    }
    if (trig.on === 'page.console' && (eventName === 'page.console' || eventName === 'page.error')) {
      return matchesPattern(String(data.message ?? ''), trig.match, trig.regex);
    }
    if (trig.on === 'page.error' && eventName === 'page.error') {
      return matchesPattern(String(data.message ?? ''), trig.match, trig.regex);
    }
    if (trig.on === 'download' && eventName === 'download.updated') {
      return matchesPattern(String(data.url ?? data.filename ?? ''), trig.match, trig.regex);
    }
    return false;
  }

  private async handleCallbackMessage(msg: Extract<NativeStreamMessage, { type: 'callback' }>) {
    // WebSocket bridge exposed function -> route as 'ws.message' trigger!
    const effectiveKind =
      msg.kind === 'page.exposed' && msg.data.name === '__dubWsEvent'
        ? 'ws.message'
        : msg.kind;
    const effectiveData =
      effectiveKind === 'ws.message' && Array.isArray(msg.data.args) && typeof msg.data.args[0] === 'object'
        ? (msg.data.args[0] as Record<string, unknown>)
        : msg.data;

    // 1. Check direct plugin callbacks first (e.g., dub.net.handle / dub.exposeFunction).
    for (const cb of this.directCallbacks.values()) {
      if (cb.kind !== msg.kind) continue;
      if (cb.networkRuleId && msg.data.ruleId && cb.networkRuleId !== msg.data.ruleId) continue;
      if (cb.kind === 'page.exposed' && cb.match && cb.match !== msg.data.name) continue;
      try {
        const decision = await cb.handler(msg.data);
        await this.browser.respondCallback(msg.callbackId, decision).catch(() => {});
      } catch (err) {
        const fallback = msg.kind === 'page.exposed'
          ? { error: err instanceof Error ? err.message : String(err) }
          : { action: 'continue' };
        await this.browser.respondCallback(msg.callbackId, fallback).catch(() => {});
      }
      return;
    }

    // 2. Match reactive triggers (code / agent / jev).
    const matched = [...this.triggers.values()].find(t => {
      if (effectiveKind === 'net.request' && t.on !== 'net.request') return false;
      if (effectiveKind === 'net.response' && t.on !== 'net.response') return false;
      if (effectiveKind === 'dialog' && t.on !== 'page.dialog') return false;
      if (effectiveKind === 'ws.message' && t.on !== 'ws.message') return false;
      if (effectiveKind === 'page.exposed' && t.on !== 'page.exposed') return false;
      if (t.networkRuleId && msg.data.ruleId && t.networkRuleId !== msg.data.ruleId) return false;
      const target = String(effectiveData.url ?? effectiveData.message ?? effectiveData.name ?? '');
      return matchesPattern(target, t.match, t.regex);
    });

    if (!matched) {
      // No local trigger matched: leave pending if user is polling callbacks.list,
      // or fail-open immediately only for non-dialog internal callbacks.
      return;
    }

    try {
      const decision = await this.executeTrigger(matched, effectiveKind, effectiveData);
      const replyPayload =
        effectiveKind === 'ws.message'
          ? { result: decision ?? { action: 'continue' } }
          : (decision ?? { action: 'continue' });
      await this.browser.respondCallback(msg.callbackId, replyPayload).catch(() => {});
    } catch {
      const fallback =
        effectiveKind === 'dialog'
          ? { accept: false }
          : effectiveKind === 'ws.message'
            ? { result: { action: 'continue' } }
            : { action: matched.failOpen === false ? 'block' : 'continue' };
      await this.browser.respondCallback(msg.callbackId, fallback).catch(() => {});
    }
  }

  async executeTrigger(
    trig: TriggerRecord,
    eventName: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    trig.fires += 1;
    if (trig.once) {
      void this.remove(trig.id);
    }

    const recordHistory = (ok: boolean, decision?: Record<string, unknown>, error?: string) => {
      this.history.push({
        id: `hist-${randomUUID().slice(0, 8)}`,
        triggerId: trig.id,
        event: eventName,
        mode: trig.mode,
        timestamp: started,
        durationMs: Date.now() - started,
        ok,
        decision,
        error,
      });
      if (this.history.length > 500) this.history.shift();
    };

    try {
      let decision: Record<string, unknown> = { action: 'continue' };

      if (trig.mode === 'code') {
        const res = await this.codeRuntime.evaluate(trig.code!, {
          realmId: trig.realmId ?? `trigger-${trig.id}`,
          event: payload,
          timeoutMs: trig.timeoutMs,
        });
        if (!res.ok) {
          throw new Error(res.error?.message ?? 'Trigger code cell failed');
        }
        if (res.output && typeof res.output === 'object' && !Array.isArray(res.output)) {
          decision = res.output as Record<string, unknown>;
        }
      } else if (trig.mode === 'agent') {
        const turn = await this.agent.runTurn({
          triggerId: trig.id,
          event: eventName,
          prompt:
            trig.prompt ??
            `Browser event "${eventName}" fired. Inspect the payload and return a JSON decision (e.g. {"action":"mock","status":200,"body":"..."} or {"action":"modify",...} or {"action":"continue"}) or a \`\`\`cell TypeScript program.`,
          payload,
          timeoutMs: trig.timeoutMs,
        });
        if (turn.code) {
          const cellRes = await this.codeRuntime.evaluate(turn.code, {
            realmId: trig.realmId ?? `trigger-${trig.id}`,
            event: payload,
            timeoutMs: trig.timeoutMs,
          });
          if (!cellRes.ok) throw new Error(cellRes.error?.message ?? 'Agent-authored cell failed');
          if (cellRes.output && typeof cellRes.output === 'object' && !Array.isArray(cellRes.output)) {
            decision = cellRes.output as Record<string, unknown>;
          }
        } else if (turn.decision) {
          decision = turn.decision;
        }
      } else if (trig.mode === 'jev') {
        const jevRes = await this.jev.ask({
          state: { event: eventName, ...payload },
          questions: trig.questions!,
        });
        const routeKey = trig.jevRouteQuestion ?? Object.keys(trig.questions!)[0]!;
        const answerVal = String(jevRes.answers[routeKey] ?? '');
        const route = trig.jevRoutes?.[answerVal];
        if (route === 'agent') {
          const turn = await this.agent.runTurn({
            triggerId: trig.id,
            event: eventName,
            prompt: trig.prompt ?? `Jev classified "${routeKey}" as "${answerVal}". Inspect and decide how to rewrite.`,
            payload: { ...payload, jev: jevRes.answers },
            timeoutMs: trig.timeoutMs,
          });
          if (turn.code) {
            const cellRes = await this.codeRuntime.evaluate(turn.code, {
              realmId: trig.realmId ?? `trigger-${trig.id}`,
              event: { ...payload, jev: jevRes.answers },
              timeoutMs: trig.timeoutMs,
            });
            if (cellRes.ok && cellRes.output && typeof cellRes.output === 'object') {
              decision = cellRes.output as Record<string, unknown>;
            }
          } else if (turn.decision) {
            decision = turn.decision;
          }
        } else if (route === 'code' && trig.code) {
          const cellRes = await this.codeRuntime.evaluate(trig.code, {
            realmId: trig.realmId ?? `trigger-${trig.id}`,
            event: { ...payload, jev: jevRes.answers },
            timeoutMs: trig.timeoutMs,
          });
          if (cellRes.ok && cellRes.output && typeof cellRes.output === 'object') {
            decision = cellRes.output as Record<string, unknown>;
          }
        } else if (route && typeof route === 'object') {
          decision = route;
        } else {
          decision = { action: 'continue', jev: jevRes.answers };
        }
      }

      recordHistory(true, decision);
      return decision;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordHistory(false, undefined, msg);
      throw err;
    }
  }

  close() {
    this.subscription?.close();
    this.subscription = undefined;
  }
}

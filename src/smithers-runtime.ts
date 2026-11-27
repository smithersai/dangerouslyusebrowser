import * as Cell from '@smthrs/harness/Cell';
import * as QuickJSSandbox from '@smthrs/harness/QuickJSSandbox';
import * as Sandbox from '@smthrs/harness/Sandbox';
import { Effect, Option, Scope } from 'effect';
import type { Schema } from 'effect';
import type { Browser, NetworkRule } from './browser.js';
import type { JevAskInput, JevClient } from './jev.js';
import type { AgentBridge } from './agent-bridge.js';

export type CodeFlowHandler = (input: Record<string, unknown>) => Promise<unknown>;

export type CodeFlowDescriptor = {
  name: string;
  description: string;
  handler: CodeFlowHandler;
};

export type CodeEvalOptions = {
  /** Persistent Smithers REPL realm ID; variables persist across calls sharing a realmId. */
  realmId?: string;
  /** Language of the cell source (defaults to 'typescript'). */
  language?: 'typescript' | 'javascript';
  /** Optional event payload injected as `const event = <json>;` for trigger cells. */
  event?: Record<string, unknown>;
  /** Whole-evaluation wall-clock timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Maximum number of ctx.call() invocations in this cell (default 64). */
  maxCalls?: number;
};

export type CodeEvalResult = {
  ok: boolean;
  realmId: string;
  frame: number;
  outcome: 'done' | 'parked' | 'continue' | 'raised' | 'rejected';
  output?: unknown;
  prints: string;
  bindings: Array<{ name: string; type: string }>;
  error?: { code: string; message: string };
};

type ActiveRealm = {
  realm: Sandbox.Realm;
  scope: Scope.Closeable;
  frame: number;
};

function makeFlowProjection(name: string, description: string): Cell.FlowProjection {
  return new Cell.FlowProjection({
    name,
    description,
    capabilities: [],
    tier: 'sealed',
    placement: Option.none(),
    input: Option.some({ type: 'object', additionalProperties: true }),
  });
}

/**
 * Smithers-backed Code-Mode Runtime built on `@smthrs/harness/QuickJSSandbox`.
 * Runs agent- or user-authored TypeScript cells inside a real QuickJS-WASM REPL realm
 * with `ctx.call(flowName, input)` bridging to Dub browser controls, Jev, and BYO agents.
 */
type SandboxInstance = Effect.Success<typeof QuickJSSandbox.make>;

export class SmithersCodeRuntime {
  private sandboxPromise?: Promise<SandboxInstance>;
  private realms = new Map<string, ActiveRealm>();
  private extraFlows = new Map<string, CodeFlowDescriptor>();

  constructor(
    private readonly browser: Browser,
    private readonly jev: JevClient,
    private readonly agent: AgentBridge
  ) {}

  registerFlow(flow: CodeFlowDescriptor) {
    this.extraFlows.set(flow.name, flow);
  }

  unregisterFlow(name: string) {
    this.extraFlows.delete(name);
  }

  listFlows(): Array<{ name: string; description: string }> {
    return [...this.buildFlowMap().values()].map(f => ({
      name: f.name,
      description: f.description,
    }));
  }

  private buildFlowMap(): Map<string, CodeFlowDescriptor> {
    const map = new Map<string, CodeFlowDescriptor>();
    const add = (name: string, description: string, handler: CodeFlowHandler) => {
      map.set(name, { name, description, handler });
    };
    this.registerTabPageFlows(add);
    this.registerNetClockFlows(add);
    this.registerControlAgentFlows(add);
    for (const [k, v] of this.extraFlows) map.set(k, v);
    return map;
  }

  private registerTabPageFlows(add: (name: string, description: string, handler: CodeFlowHandler) => void): void {
    add('dub.status', 'Get running Dub browser info and capabilities', () => this.browser.info());
    add('dub.tabs.list', 'List all tabs with stable IDs', () => this.browser.tabs());
    add('dub.tabs.open', 'Open a tab: { url, waitUntil?, ephemeral? }', i =>
      this.browser.open(String(i.url ?? 'about:blank'), {
        waitUntil: i.waitUntil as 'none' | 'commit' | 'domcontentloaded' | 'load' | 'networkidle' | undefined,
        ephemeral: Boolean(i.ephemeral),
      })
    );
    add('dub.tabs.close', 'Close a tab: { tab }', i => this.browser.close(Number(i.tab)));
    add('dub.tabs.activate', 'Activate a tab: { tab }', i => this.browser.activate(Number(i.tab)));
    add('dub.tabs.navigate', 'Navigate a tab: { tab, url, waitUntil? }', i =>
      this.browser.navigate(Number(i.tab), String(i.url), {
        waitUntil: i.waitUntil as 'none' | 'commit' | 'domcontentloaded' | 'load' | 'networkidle' | undefined,
      })
    );
    add('dub.tabs.back', 'Navigate back: { tab, waitUntil? }', i => this.browser.back(Number(i.tab)));
    add('dub.tabs.forward', 'Navigate forward: { tab, waitUntil? }', i => this.browser.forward(Number(i.tab)));
    add('dub.tabs.reload', 'Reload a tab: { tab, ignoreCache?, waitUntil? }', i =>
      this.browser.reload(Number(i.tab), { ignoreCache: Boolean(i.ignoreCache) })
    );
    add('dub.frames.list', 'List frames in a tab: { tab }', i => this.browser.frames(Number(i.tab)));
    add('dub.page.evaluate', 'Evaluate JS in a tab/frame: { tab, expression, frameId?, world? }', i =>
      this.browser.evaluate(Number(i.tab), String(i.expression), {
        frameId: i.frameId ? String(i.frameId) : undefined,
        world: i.world === 'isolated' ? 'isolated' : 'main',
      })
    );
    add('dub.page.snapshot', 'Capture accessibility/interactive DOM snapshot with nodeIds: { tab, frameId?, maxNodes?, includeHidden? }', i =>
      this.browser.snapshot(Number(i.tab), {
        frameId: i.frameId ? String(i.frameId) : undefined,
        maxNodes: i.maxNodes ? Number(i.maxNodes) : undefined,
        includeHidden: Boolean(i.includeHidden),
      })
    );
    add('dub.page.console', 'Read console logs & errors: { tab, since?, level?, clear? }', i =>
      this.browser.console(Number(i.tab), {
        since: i.since ? Number(i.since) : 0,
        level: i.level ? String(i.level) : undefined,
        clear: Boolean(i.clear),
      })
    );
    add('dub.page.wait', 'Wait for selector, text, or expression: { tab, selector?, text?, expression?, state?, timeoutMs? }', i =>
      this.browser.wait(Number(i.tab), i as never)
    );
    add('dub.page.screenshot', 'Capture tab screenshot: { tab, clip?, format?, quality? }', i =>
      this.browser.screenshot(Number(i.tab), i as never)
    );
    add('dub.page.viewport', 'Get or set viewport dimensions: { tab, width?, height? }', i =>
      this.browser.viewport(Number(i.tab), {
        width: i.width ? Number(i.width) : undefined,
        height: i.height ? Number(i.height) : undefined,
      })
    );
    add('dub.page.emulate', 'Emulate userAgent, colorScheme, locale, geolocation, or randomSeed: { tab, ... }', i =>
      this.browser.emulate(Number(i.tab), i as never)
    );
    add('dub.tools.list', 'List native actor & WebMCP tools: { tab }', i => this.browser.tools(Number(i.tab)));
    add('dub.tools.call', 'Invoke a native actor or WebMCP tool: { tab, name, input? }', i =>
      this.browser.tool(Number(i.tab), String(i.name), (i.input as Record<string, unknown>) ?? {})
    );
  }

  private registerNetClockFlows(add: (name: string, description: string, handler: CodeFlowHandler) => void): void {
    add('dub.net.set', 'Set a live network rule: { match, action, ... }', i =>
      this.browser.setRule(i as unknown as NetworkRule)
    );
    add('dub.net.list', 'List active network rules', () => this.browser.rules());
    add('dub.net.remove', 'Remove a network rule: { id }', i => this.browser.removeRule(String(i.id)));
    add('dub.net.log', 'Read network log: { match?, since? }', i =>
      this.browser.networkLog(String(i.match ?? ''), Number(i.since ?? 0))
    );
    add('dub.net.inspect', 'Inspect full captured headers/body of a network log seq: { seq }', i =>
      this.browser.inspectNetwork(Number(i.seq))
    );
    add('dub.net.config', 'Configure network body capture: { captureBodies?, maxBodyBytes? }', i =>
      this.browser.networkConfig(i as never)
    );
    add('dub.clock.freeze', 'Freeze per-tab virtual clock: { tab, at }', i =>
      this.browser.freeze(Number(i.tab), String(i.at))
    );
    add('dub.clock.advance', 'Advance virtual clock: { tab, milliseconds }', i =>
      this.browser.advance(Number(i.tab), Number(i.milliseconds))
    );
    add('dub.clock.step', 'Step animation frames: { tab, frames? }', i =>
      this.browser.step(Number(i.tab), Number(i.frames ?? 1))
    );
    add('dub.clock.resume', 'Resume real time: { tab }', i => this.browser.resume(Number(i.tab)));
    add('dub.cookies.list', 'List cookies: { url? }', i =>
      this.browser.cookies(i.url ? String(i.url) : undefined)
    );
    add('dub.cookies.set', 'Set a cookie: { url, name, value, ... }', i => this.browser.setCookie(i as never));
    add('dub.cookies.delete', 'Delete cookies: { url?, name?, domain? }', i => this.browser.deleteCookies(i as never));
    add('dub.storage.export', 'Export cookies & web storage for a tab: { tab }', i =>
      this.browser.exportStorage(Number(i.tab))
    );
    add('dub.storage.import', 'Import cookies & web storage into a tab: { tab, state }', i =>
      this.browser.importStorage(Number(i.tab), (i.state as Record<string, unknown>) ?? {})
    );
  }

  private registerControlAgentFlows(add: (name: string, description: string, handler: CodeFlowHandler) => void): void {
    add('dub.dialog.policy', 'Get/set dialog policy: { mode?, promptText?, timeoutMs? }', i =>
      this.browser.dialogPolicy(i.mode ? (i as never) : undefined)
    );
    add('dub.dialog.list', 'List pending JS dialogs', () => this.browser.dialogs());
    add('dub.dialog.respond', 'Respond to a JS dialog: { id, accept, promptText? }', i =>
      this.browser.respondDialog(String(i.id), Boolean(i.accept), i.promptText ? String(i.promptText) : undefined)
    );
    add('dub.downloads.list', 'List browser downloads', () => this.browser.downloads());
    add('dub.clipboard.read', 'Read clipboard text', () => this.browser.clipboardRead());
    add('dub.clipboard.write', 'Write clipboard text: { text }', i => this.browser.clipboardWrite(String(i.text ?? '')));
    add('dub.scripts.add', 'Add an init script: { match?, source, world?, allFrames? }', i =>
      this.browser.addScript(i as never)
    );
    add('dub.scripts.remove', 'Remove an init script: { id }', i => this.browser.removeScript(String(i.id)));
    add('dub.scripts.list', 'List init scripts and exposed functions', () => this.browser.scripts());
    add('jev', 'Ask Jev (fast typed decision model) boolean/choice/score questions about a JSON state: { state, questions }', i =>
      this.jev.ask(i as unknown as JevAskInput)
    );
    add('agent.turn', 'Trigger a new turn of the user BYO agent to inspect/decide/rewrite: { event?, prompt, payload?, timeoutMs? }', async i => {
      const response = await this.agent.runTurn({
        event: String(i.event ?? 'code.callback'),
        prompt: String(i.prompt ?? 'Inspect payload and return a JSON decision or code-mode cell.'),
        payload: (i.payload as Record<string, unknown>) ?? {},
        timeoutMs: i.timeoutMs ? Number(i.timeoutMs) : 30000,
      });
      if (response.code) {
        const sub = await this.evaluate(response.code, {
          realmId: `agent-turn-${Date.now()}`,
          event: (i.payload as Record<string, unknown>) ?? {},
          timeoutMs: i.timeoutMs ? Number(i.timeoutMs) : 30000,
        });
        return {
          adapter: response.adapter,
          executedCell: true,
          decision: sub.output,
          prints: sub.prints,
          ok: sub.ok,
          ...(sub.error ? { error: sub.error } : {}),
        };
      }
      return response;
    });
  }

  private async getSandbox(): Promise<SandboxInstance> {
    if (!this.sandboxPromise) {
      this.sandboxPromise = Effect.runPromise(
        QuickJSSandbox.make.pipe(
          Effect.provide(QuickJSSandbox.layerVariantLive),
          Effect.provide(QuickJSSandbox.layerClockLive)
        )
      );
    }
    return this.sandboxPromise;
  }

  private buildProjections(flows: Map<string, CodeFlowDescriptor>): Record<string, Cell.FlowProjection> {
    const out: Record<string, Cell.FlowProjection> = {};
    for (const f of flows.values()) {
      out[f.name] = makeFlowProjection(f.name, f.description);
    }
    return out;
  }

  private async getOrCreateRealm(realmId: string, projections: Record<string, Cell.FlowProjection>): Promise<ActiveRealm> {
    const existing = this.realms.get(realmId);
    if (existing) return existing;
    const sandbox = await this.getSandbox();
    const scope = Effect.runSync(Scope.make());
    const realm = (await Effect.runPromise(
      sandbox.openRealm!({
        flows: projections,
        limits: {
          calls: 64,
          memoryBytes: 64 * 1024 * 1024,
          steps: 2_000_000,
          timeMs: 10_000,
          totalMs: 60_000,
          callMs: 30_000,
        },
      }).pipe(Scope.provide(scope))
    )) as Sandbox.Realm;
    const active: ActiveRealm = { realm, scope, frame: 0 };
    this.realms.set(realmId, active);
    return active;
  }

  async resetRealm(realmId = 'default'): Promise<boolean> {
    const existing = this.realms.get(realmId);
    if (!existing) return false;
    this.realms.delete(realmId);
    await Effect.runPromise(Scope.close(existing.scope, { _tag: 'Success', value: undefined } as never)).catch(() => {});
    return true;
  }

  listRealms(): Array<{ realmId: string; frames: number }> {
    return [...this.realms.entries()].map(([realmId, r]) => ({ realmId, frames: r.frame }));
  }

  private createCallHandler(flows: Map<string, CodeFlowDescriptor>): Sandbox.Handler {
    return invocation =>
      Effect.promise(async () => {
        const flow = flows.get(invocation.flow);
        if (!flow) {
          return {
            outcome: 'failure',
            code: 'unknown_flow',
            message: `Unknown flow: ${invocation.flow}`,
            value: null,
          } as Cell.CallResult;
        }
        try {
          const inputObj =
            invocation.input && typeof invocation.input === 'object' && !Array.isArray(invocation.input)
              ? (invocation.input as Record<string, unknown>)
              : { value: invocation.input };
          const result = await flow.handler(inputObj);
          const safeJson = result === undefined ? null : JSON.parse(JSON.stringify(result));
          return { outcome: 'success', value: safeJson as Schema.Json } as Cell.CallResult;
        } catch (err) {
          return {
            outcome: 'failure',
            code: 'flow_failed',
            message: err instanceof Error ? err.message : String(err),
            value: null,
          } as Cell.CallResult;
        }
      });
  }

  private formatEvalResult(
    realmId: string,
    frame: number,
    frameResult: { bindings: ReadonlyArray<{ name: string; type: string }>; prints: string; outcome: unknown }
  ): CodeEvalResult {
    const bindings = frameResult.bindings.map(b => ({ name: b.name, type: b.type }));
    const outcome = frameResult.outcome as Record<string, unknown>;
    const tag = String(outcome._tag ?? '');

    if (tag === 'settled') {
      const transition = outcome.transition as Record<string, unknown> | undefined;
      const tTag = String(transition?._tag ?? 'continue');
      if (tTag === 'complete') {
        return {
          ok: true,
          realmId,
          frame,
          outcome: 'done',
          output: transition?.value !== undefined ? transition.value : transition?.output,
          prints: frameResult.prints,
          bindings,
        };
      }
      if (tTag === 'park') {
        return {
          ok: true,
          realmId,
          frame,
          outcome: 'parked',
          output: { reason: transition?.reason, message: transition?.message },
          prints: frameResult.prints,
          bindings,
        };
      }
      return { ok: true, realmId, frame, outcome: 'continue', prints: frameResult.prints, bindings };
    }

    if (tag === 'raised') {
      const errObj = outcome.error as { name?: string; message?: string } | undefined;
      return {
        ok: false,
        realmId,
        frame,
        outcome: 'raised',
        prints: frameResult.prints,
        bindings,
        error: { code: errObj?.name ?? 'Error', message: errObj?.message ?? 'Cell threw an exception' },
      };
    }

    return {
      ok: false,
      realmId,
      frame,
      outcome: 'rejected',
      prints: frameResult.prints,
      bindings,
      error: {
        code: String(outcome.reason ?? 'rejected'),
        message: String(outcome.message ?? 'Cell was rejected by QuickJS sandbox'),
      },
    };
  }

  async evaluate(code: string, opts: CodeEvalOptions = {}): Promise<CodeEvalResult> {
    const realmId = opts.realmId ?? 'default';
    const flows = this.buildFlowMap();
    const projections = this.buildProjections(flows);
    const active = await this.getOrCreateRealm(realmId, projections);
    active.frame += 1;

    const prefix = opts.event !== undefined ? `var event = ${JSON.stringify(opts.event)};\n` : '';
    const source = Cell.source(`${prefix}${code}`, opts.language ?? 'typescript');
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 500), 120_000);
    const frameResult = await Effect.runPromise(
      active.realm.evaluate({
        cell: source,
        flows: projections,
        frame: active.frame,
        call: this.createCallHandler(flows),
        limits: {
          calls: opts.maxCalls ?? 64,
          totalMs: timeoutMs,
          callMs: Math.min(timeoutMs, 30_000),
        },
      })
    );

    return this.formatEvalResult(realmId, active.frame, frameResult);
  }

  async close() {
    for (const id of [...this.realms.keys()]) {
      await this.resetRealm(id);
    }
  }
}

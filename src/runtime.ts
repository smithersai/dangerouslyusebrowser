import type { Browser } from './browser.js';
import { JevClient, type JevConfig } from './jev.js';
import { AgentBridge, type AgentAdapterConfig } from './agent-bridge.js';
import { SmithersCodeRuntime } from './smithers-runtime.js';
import { TriggerEngine } from './triggers.js';
import { PluginManager } from './plugins.js';

export type DubRuntimeOptions = {
  jev?: JevConfig;
  agent?: AgentAdapterConfig;
};

/**
 * Cohesive runtime composing Dub's native Chromium Browser with Smithers'
 * QuickJS code-mode sandbox, Jev evaluator, BYO agent bridge, reactive triggers,
 * and hot-loadable TypeScript code plugins.
 */
export class DubRuntime {
  public readonly jev: JevClient;
  public readonly agent: AgentBridge;
  public readonly code: SmithersCodeRuntime;
  public readonly triggers: TriggerEngine;
  public readonly plugins: PluginManager;

  constructor(
    public readonly browser: Browser,
    options: DubRuntimeOptions = {}
  ) {
    this.jev = new JevClient(options.jev);
    this.agent = new AgentBridge(options.agent);
    this.code = new SmithersCodeRuntime(browser, this.jev, this.agent);
    this.triggers = new TriggerEngine(browser, this.code, this.jev, this.agent);
    this.plugins = new PluginManager(browser, this.triggers, this.code, this.jev, this.agent);
  }

  async close() {
    await this.plugins.closeAll().catch(() => {});
    this.triggers.close();
    this.agent.shutdown();
    await this.code.close().catch(() => {});
  }
}

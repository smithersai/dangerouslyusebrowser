import { NativeBridge } from './native.js';
import { z } from 'incur';

export const browserInfo = z.object({
  product: z.literal('Dub'), protocol: z.literal(1), chromium: z.string(), revision: z.string(),
  buildId: z.string().optional(), instanceId: z.string().optional(),
  methods: z.array(z.string()), tools: z.array(z.string()).optional(), profile: z.string(),
});
export type BrowserInfo = z.infer<typeof browserInfo>;
export type Tab = { id: number; url: string; title: string; active: boolean; loading: boolean };
export type NetworkRule = {
  id?: string; match: string; action: 'mock' | 'block' | 'redirect' | 'patch';
  status?: number; body?: string; headers?: Record<string, string>; url?: string; replace?: string; with?: string;
};
export class Browser {
  constructor(public readonly native = new NativeBridge()) {}
  async info(): Promise<BrowserInfo> { return browserInfo.parse(await this.native.call('browser.info')); }
  tabs() { return this.native.call<{ tabs: Tab[] }>('tabs.list'); }
  open(url = 'about:blank') { return this.native.call<Tab>('tabs.open', { url }); }
  close(tab: number) { return this.native.call('tabs.close', { tab }); }
  activate(tab: number) { return this.native.call('tabs.activate', { tab }); }
  navigate(tab: number, url: string) { return this.native.call<Tab>('tabs.navigate', { tab, url }); }
  evaluate(tab: number, expression: string) { return this.native.call('page.evaluate', { tab, expression }); }
  screenshot(tab: number) { return this.native.call<{ mimeType: 'image/png'; data: string }>('page.screenshot', { tab }); }
  tools(tab: number) { return this.native.call('tools.list', { tab }); }
  tool(tab: number, name: string, input: Record<string, unknown> = {}) { return this.native.call('tools.call', { tab, name, input }); }
  setRule(rule: NetworkRule) { return this.native.call('net.set', { ...rule }); }
  rules() { return this.native.call('net.list'); }
  removeRule(id: string) { return this.native.call('net.remove', { id }); }
  networkLog(match = '', since = 0) { return this.native.call('net.log', { match, since }); }
  freeze(tab: number, at: string) { return this.native.call('clock.freeze', { tab, at }); }
  advance(tab: number, milliseconds: number) { return this.native.call('clock.advance', { tab, milliseconds }); }
  step(tab: number, frames = 1) { return this.native.call('clock.step', { tab, frames }); }
  resume(tab: number) { return this.native.call('clock.resume', { tab }); }
}
export function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('Use a duration such as 250ms, 2s, 5m, 1h or 31d');
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const milliseconds = Number(match[1]) * scale[match[2]!]!;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error('Duration must be a positive whole number of milliseconds');
  return milliseconds;
}

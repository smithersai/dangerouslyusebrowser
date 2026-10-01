import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'incur';

const envelope = z.object({
  protocol: z.literal(1), id: z.string(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).refine(v => Object.hasOwn(v, 'result') !== !!v.error, 'Expected exactly one of result or error');
type Addon = { request(path: string, json: string, timeout: number): Promise<string> };
let addon: Addon | undefined;
function binding(): Addon {
  try { return addon ??= createRequire(import.meta.url)('../build/Release/dub.node') as Addon; }
  catch (cause) { throw new Error('Dub native binding is missing. Run npm run build:native in the Dub installation.', { cause }); }
}
export const defaultSocket = () => process.env.DUB_SOCKET || join(homedir(), '.dub', 'browser.sock');
export class DubError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DubError'; }
}
export class NativeBridge {
  constructor(public readonly socket = defaultSocket(), public readonly timeoutMs = 30000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new RangeError('timeoutMs must be 1–300000');
  }
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!/^[a-z][a-z0-9_.]*$/.test(method)) throw new TypeError('Invalid native method name');
    const id = randomUUID();
    const reply = envelope.parse(JSON.parse(await binding().request(this.socket, JSON.stringify({ protocol: 1, id, method, params }), this.timeoutMs)));
    if (reply.id !== id) throw new DubError('PROTOCOL', 'Dub response ID did not match the request');
    if (reply.error) throw new DubError(reply.error.code, reply.error.message);
    return reply.result as T;
  }
}

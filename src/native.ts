import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'incur';

const envelope = z.object({
  protocol: z.literal(1), id: z.string(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).refine(v => Object.hasOwn(v, 'result') !== !!v.error, 'Expected exactly one of result or error');

export type NativeStreamMessage =
  | { protocol: 1; type: 'event'; event: string; data: Record<string, unknown> }
  | { protocol: 1; type: 'callback'; callbackId: string; kind: string; deadlineMs: number; data: Record<string, unknown> };

export type NativeSubscription = {
  streamId: string;
  close: () => void;
};

type RawStream = { ack: string; close: () => void };
type Addon = {
  request(path: string, json: string, timeout: number): Promise<string>;
  subscribe?: (
    path: string,
    json: string,
    timeout: number,
    callback: (kind: 'message' | 'close' | 'error', payload: string) => void
  ) => Promise<RawStream>;
};
let addon: Addon | undefined;
function binding(): Addon {
  if (addon) return addon;
  const req = createRequire(import.meta.url);
  const candidates = [
    '../build/Release/dub.node',
    `../prebuilds/${process.platform}-${process.arch}/dub.node`,
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      addon = req(candidate) as Addon;
      return addon;
    } catch (cause) {
      lastError = cause;
    }
  }
  throw new Error('Dub native binding is missing. Run npm run build:native in the Dub installation.', { cause: lastError });
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
    const reply = envelope.parse(JSON.parse(await binding().request(
      this.socket,
      JSON.stringify({ protocol: 1, id, method, params, timeoutMs: this.timeoutMs }),
      this.timeoutMs
    )));
    if (reply.id !== id) throw new DubError('PROTOCOL', 'Dub response ID did not match the request');
    if (reply.error) throw new DubError(reply.error.code, reply.error.message);
    return reply.result as T;
  }
  async subscribe(
    handlers: {
      events?: string[];
      onMessage: (message: NativeStreamMessage) => void;
      onClose?: (error?: string) => void;
    }
  ): Promise<NativeSubscription> {
    const sub = binding().subscribe;
    if (!sub) throw new DubError('UNSUPPORTED', 'Installed Dub native binding does not support event streams. Run npm run build:native.');
    const id = randomUUID();
    const raw = await sub(
      this.socket,
      JSON.stringify({
        protocol: 1,
        id,
        method: 'events.subscribe',
        params: handlers.events ? { events: handlers.events } : {},
        timeoutMs: Math.min(this.timeoutMs, 10000),
      }),
      Math.min(this.timeoutMs, 10000),
      (kind, payload) => {
        if (kind === 'message') {
          try {
            const parsed = JSON.parse(payload) as NativeStreamMessage;
            handlers.onMessage(parsed);
          } catch {
            // Ignore malformed stream frames rather than crashing the host.
          }
        } else {
          handlers.onClose?.(kind === 'error' ? payload : undefined);
        }
      }
    );
    const ack = envelope.parse(JSON.parse(raw.ack));
    if (ack.id !== id) {
      raw.close();
      throw new DubError('PROTOCOL', 'Dub subscribe ack ID did not match the request');
    }
    if (ack.error) {
      raw.close();
      throw new DubError(ack.error.code, ack.error.message);
    }
    const result = (ack.result ?? {}) as { streamId?: string };
    return {
      streamId: result.streamId ?? id,
      close: () => raw.close(),
    };
  }
}

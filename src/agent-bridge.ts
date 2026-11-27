import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type AgentTurnRequest = {
  turnId: string;
  triggerId?: string;
  event: string;
  prompt: string;
  payload: Record<string, unknown>;
  mcpEndpoint?: string;
  timeoutMs: number;
};

export type AgentTurnResponse = {
  /** Direct structured rewrite/action decision returned by the agent. */
  decision?: Record<string, unknown>;
  /** Optional Smithers code-mode TypeScript cell emitted by the agent to run & produce the decision. */
  code?: string;
  /** Optional free-text explanation or answer from the agent. */
  text?: string;
  /** Which adapter fulfilled the turn. */
  adapter: string;
};

export type AgentAdapterConfig =
  | { kind: 'handoff' }
  | {
      kind: 'cli';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      kind: 'http';
      url: string;
      apiKey?: string;
      model?: string;
      headers?: Record<string, string>;
      format?: 'openai' | 'anthropic' | 'webhook';
    }
  | {
      kind: 'custom';
      handler: (req: AgentTurnRequest) => Promise<AgentTurnResponse | Record<string, unknown>>;
    };

type PendingHandoff = {
  request: AgentTurnRequest;
  createdAt: number;
  resolve: (response: AgentTurnResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Extracts a fenced `cell`, `ts`, `typescript`, or `js` code block from an LLM reply,
 * matching Smithers' cell recovery model.
 */
export function extractCellCode(text: string): string | undefined {
  const regex = /```(?:cell|ts|typescript|js|javascript)\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]?.trim()) blocks.push(match[1].trim());
  }
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/**
 * Extracts a JSON object decision from an LLM reply (raw JSON or ```json block).
 */
export function extractJsonDecision(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const tryParse = (s: string) => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return undefined;
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = /```json\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return undefined;
}

/**
 * BYO Agent Bridge: lets the user plug in their own agent (CLI, HTTP model/webhook,
 * programmatic TS callback, or universal MCP turn handoff) so browser events can
 * trigger a new LLM turn to inspect and rewrite behavior.
 */
export class AgentBridge {
  private config: AgentAdapterConfig;
  private mcpEndpoint?: string;
  private pending = new Map<string, PendingHandoff>();
  private waiters: Array<{
    resolve: (req: AgentTurnRequest | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(config?: AgentAdapterConfig) {
    if (config) {
      this.config = config;
    } else if (process.env.DUB_AGENT_CMD) {
      const parts = process.env.DUB_AGENT_CMD.trim().split(/\s+/);
      this.config = { kind: 'cli', command: parts[0]!, args: parts.slice(1) };
    } else if (process.env.DUB_AGENT_URL) {
      this.config = {
        kind: 'http',
        url: process.env.DUB_AGENT_URL,
        apiKey: process.env.DUB_AGENT_API_KEY,
        model: process.env.DUB_AGENT_MODEL,
        format: (process.env.DUB_AGENT_FORMAT as 'openai' | 'anthropic' | 'webhook' | undefined) ?? 'webhook',
      };
    } else {
      this.config = { kind: 'handoff' };
    }
  }

  setMcpEndpoint(endpoint: string) {
    this.mcpEndpoint = endpoint;
  }

  configure(config: AgentAdapterConfig) {
    this.config = config;
  }

  describe() {
    if (this.config.kind === 'cli') {
      return { kind: 'cli', command: this.config.command, args: this.config.args ?? [] };
    }
    if (this.config.kind === 'http') {
      return { kind: 'http', url: this.config.url, model: this.config.model, format: this.config.format ?? 'webhook' };
    }
    return { kind: this.config.kind };
  }

  listPendingTurns() {
    return [...this.pending.values()].map(p => ({
      turnId: p.request.turnId,
      triggerId: p.request.triggerId,
      event: p.request.event,
      prompt: p.request.prompt,
      payload: p.request.payload,
      createdAt: p.createdAt,
      timeoutMs: p.request.timeoutMs,
    }));
  }

  async awaitTurn(timeoutMs = 30000): Promise<AgentTurnRequest | null> {
    const first = this.pending.values().next();
    if (!first.done) return first.value.request;
    return new Promise<AgentTurnRequest | null>(resolve => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, Math.min(Math.max(timeoutMs, 50), 120000));
      timer.unref?.();
      this.waiters.push({ resolve, timer });
    });
  }

  resolveTurn(turnId: string, response: { decision?: Record<string, unknown>; code?: string; text?: string }): boolean {
    const entry = this.pending.get(turnId);
    if (!entry) return false;
    this.pending.delete(turnId);
    clearTimeout(entry.timer);
    entry.resolve({ ...response, adapter: 'handoff' });
    return true;
  }

  async runTurn(input: {
    triggerId?: string;
    event: string;
    prompt: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<AgentTurnResponse> {
    const req: AgentTurnRequest = {
      turnId: `turn-${randomUUID().slice(0, 12)}`,
      triggerId: input.triggerId,
      event: input.event,
      prompt: input.prompt,
      payload: input.payload,
      mcpEndpoint: this.mcpEndpoint,
      timeoutMs: Math.min(Math.max(input.timeoutMs ?? 30000, 200), 120000),
    };

    if (this.config.kind === 'custom') {
      const raw = await Promise.race([
        this.config.handler(req),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('BYO custom agent timed out')), req.timeoutMs);
          t.unref?.();
        }),
      ]);
      if (raw && typeof raw === 'object' && ('decision' in raw || 'code' in raw || 'text' in raw)) {
        return { ...(raw as AgentTurnResponse), adapter: 'custom' };
      }
      return { decision: raw as Record<string, unknown>, adapter: 'custom' };
    }

    if (this.config.kind === 'cli') {
      return this.runCliTurn(this.config, req);
    }

    if (this.config.kind === 'http') {
      return this.runHttpTurn(this.config, req);
    }

    // Universal 'handoff' mode: park the turn so the connected LLM / MCP client
    // gets a fresh turn via `triggers.await` / `triggers.pending` + `triggers.resolve`.
    return new Promise<AgentTurnResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.turnId);
        reject(new Error(`Turn ${req.turnId} timed out waiting for agent handoff`));
      }, req.timeoutMs);
      timer.unref?.();
      this.pending.set(req.turnId, { request: req, createdAt: Date.now(), resolve, reject, timer });
      const waiters = this.waiters.splice(0, this.waiters.length);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(req);
      }
    });
  }

  private runCliTurn(
    cfg: Extract<AgentAdapterConfig, { kind: 'cli' }>,
    req: AgentTurnRequest
  ): Promise<AgentTurnResponse> {
    return new Promise((resolve, reject) => {
      const child = spawn(cfg.command, cfg.args ?? [], {
        env: {
          ...process.env,
          ...cfg.env,
          DUB_TURN_ID: req.turnId,
          DUB_EVENT: req.event,
          ...(req.mcpEndpoint ? { DUB_MCP_ENDPOINT: req.mcpEndpoint } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`BYO agent CLI timed out after ${req.timeoutMs}ms`));
      }, req.timeoutMs);
      timer.unref?.();
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`BYO agent CLI exited with ${code}: ${stderr.slice(-500)}`));
          return;
        }
        const cellCode = extractCellCode(stdout);
        const decision = cellCode ? undefined : extractJsonDecision(stdout);
        resolve({ decision, code: cellCode, text: stdout.trim(), adapter: 'cli' });
      });
      child.stdin.end(JSON.stringify(req));
    });
  }

  private async runHttpTurn(
    cfg: Extract<AgentAdapterConfig, { kind: 'http' }>,
    req: AgentTurnRequest
  ): Promise<AgentTurnResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...cfg.headers,
      };
      const format = cfg.format ?? 'webhook';
      let body: unknown;
      if (format === 'openai') {
        if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
        body = {
          model: cfg.model ?? 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are a browser control agent triggered by Dub. Reply with either a JSON decision object (e.g. {"action":"mock","status":200,"body":"..."} or {"action":"continue"}) OR a fenced ```cell TypeScript program calling ctx.call(...) and ctx.done(decision).',
            },
            {
              role: 'user',
              content: `${req.prompt}\n\nEvent: ${req.event}\nPayload:\n${JSON.stringify(req.payload, null, 2)}`,
            },
          ],
        };
      } else if (format === 'anthropic') {
        if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
        body = {
          model: cfg.model ?? 'claude-sonnet-4-5',
          max_tokens: 2048,
          system:
            'You are a browser control agent triggered by Dub. Reply with either a JSON decision object OR a fenced ```cell TypeScript program calling ctx.call(...) and ctx.done(decision).',
          messages: [
            {
              role: 'user',
              content: `${req.prompt}\n\nEvent: ${req.event}\nPayload:\n${JSON.stringify(req.payload, null, 2)}`,
            },
          ],
        };
      } else {
        if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
        body = req;
      }

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`BYO agent HTTP endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const rawText = await res.text();
      let text = rawText;
      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (format === 'webhook') {
          return {
            decision: (parsed.decision as Record<string, unknown> | undefined) ?? (!parsed.code ? parsed : undefined),
            code: typeof parsed.code === 'string' ? parsed.code : undefined,
            text: typeof parsed.text === 'string' ? parsed.text : rawText,
            adapter: 'http',
          };
        }
        if (format === 'openai') {
          const choices = parsed.choices as Array<{ message?: { content?: string } }> | undefined;
          text = choices?.[0]?.message?.content ?? rawText;
        } else if (format === 'anthropic') {
          const content = parsed.content as Array<{ text?: string }> | undefined;
          text = content?.map(c => c.text ?? '').join('\n') ?? rawText;
        }
      } catch {}
      const cellCode = extractCellCode(text);
      const decision = cellCode ? undefined : extractJsonDecision(text);
      return { decision, code: cellCode, text, adapter: 'http' };
    } finally {
      clearTimeout(timer);
    }
  }

  shutdown() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`AgentBridge shutting down while turn ${id} was pending`));
    }
    this.pending.clear();
    for (const w of this.waiters.splice(0, this.waiters.length)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }
}

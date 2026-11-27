import { Cli, z } from 'incur';
import { Browser } from './browser.js';
import { createCommands } from './commands.js';
import { installBrowser } from './download.js';
import { listen, type ListenHandle } from './http.js';
import { launch, type Session } from './launch.js';
import { DubRuntime } from './runtime.js';
import type { AgentAdapterConfig } from './agent-bridge.js';
import type { MintOneTimeTokenOptions } from './auth.js';

type ServeOptions = {
  port: number;
  host: string;
  browser?: string;
  socket?: string;
  profile?: string;
  profileName?: string;
  headless: boolean;
  connect: boolean;
  plugin?: string;
  watch: boolean;
  agentCmd?: string;
  agentUrl?: string;
  agentModel?: string;
  agentFormat?: 'openai' | 'anthropic' | 'webhook';
  printOneTimeToken: boolean;
  sandboxId?: string;
  tokenRole: 'maintainer' | 'contributor' | 'sandbox' | 'agent' | 'viewer';
  tokenTrust?: 'trusted' | 'untrusted';
  tokenTtlSeconds: number;
  allowedHost?: string;
};

function resolveAgentConfig(opts: ServeOptions): AgentAdapterConfig | undefined {
  if (opts.agentCmd) {
    const parts = opts.agentCmd.trim().split(/\s+/);
    return { kind: 'cli', command: parts[0]!, args: parts.slice(1) };
  }
  if (opts.agentUrl) {
    return {
      kind: 'http',
      url: opts.agentUrl,
      apiKey: process.env.DUB_AGENT_API_KEY,
      model: opts.agentModel,
      format: opts.agentFormat ?? 'webhook',
    };
  }
  return undefined;
}

function resolveBootstrapToken(opts: ServeOptions): MintOneTimeTokenOptions | undefined {
  if (!opts.printOneTimeToken) return undefined;
  return {
    principal: opts.sandboxId ? `sandbox:${opts.sandboxId}` : `${opts.tokenRole}-bootstrap`,
    role: opts.tokenRole,
    trust: opts.tokenTrust,
    sandboxId: opts.sandboxId,
    ttlMs: opts.tokenTtlSeconds * 1000,
    issuedBy: 'dub-cli',
  };
}

function attachShutdownHandlers(runtime: DubRuntime, server: ListenHandle, session: Session): void {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime.close(); } catch (error) { console.error(error); }
    try { await server.close(); }
    catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      try { await session.close(); }
      catch (error) { console.error(error); process.exitCode = 1; }
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function runServe(opts: ServeOptions) {
  const session = await launch(opts);
  const runtime = new DubRuntime(session.browser, { agent: resolveAgentConfig(opts) });
  try {
    const capabilities = { methods: session.info.methods, tools: session.info.tools };
    const allowedHosts = opts.allowedHost
      ? opts.allowedHost.split(',').map(h => h.trim()).filter(Boolean)
      : undefined;
    const bootstrapToken = resolveBootstrapToken(opts);
    const server = await listen(createCommands(session.browser, capabilities, runtime).fetch, {
      ...opts,
      token: process.env.DUB_TOKEN,
      requireAuth: Boolean(process.env.DUB_TOKEN || bootstrapToken),
      bootstrapToken,
      allowedHosts,
      health: () => session.health(),
    });
    runtime.agent.setMcpEndpoint(`${server.url}/mcp`);
    const loadedPlugins: string[] = [];
    if (opts.plugin) {
      for (const p of opts.plugin.split(',').map(s => s.trim()).filter(Boolean)) {
        const loaded = await runtime.plugins.loadFromFile(p, { watch: opts.watch });
        loadedPlugins.push(loaded.name);
      }
    }
    attachShutdownHandlers(runtime, server, session);
    return {
      endpoint: `${server.url}/mcp`,
      exchangeEndpoint: `${server.url}/auth/exchange`,
      socket: session.browser.native.socket,
      browser: session.info,
      plugins: loadedPlugins,
      agent: runtime.agent.describe(),
      jev: { configured: runtime.jev.isConfigured, model: runtime.jev.modelId },
      ...(server.bootstrap
        ? {
            oneTimeAuth: {
              token: server.bootstrap.oneTimeToken,
              tokenId: server.bootstrap.tokenId,
              role: server.bootstrap.role,
              trust: server.bootstrap.trust,
              scopes: server.bootstrap.scopes,
              expiresAt: server.bootstrap.expiresAt,
              redeem: `POST ${server.url}/auth/exchange {"token":"<one-time-token>"}`,
            },
          }
        : {}),
    };
  } catch (error) {
    await runtime.close().catch(() => {});
    await session.close();
    throw error;
  }
}

function createAuthCli() {
  const auth = Cli.create('auth', { description: 'Mint and redeem single-use sandbox/agent MCP tokens' });
  auth.command('mint', {
    description: 'Mint a single-use one-time token from an authenticated Dub MCP server',
    mcp: false,
    options: z.object({
      url: z.string().url().default(process.env.DUB_MCP_URL || 'http://127.0.0.1:7777'),
      principal: z.string().min(1).default('sandbox:ephemeral'),
      role: z.enum(['maintainer', 'contributor', 'sandbox', 'agent', 'viewer']).default('sandbox'),
      trust: z.enum(['trusted', 'untrusted']).optional(),
      sandboxId: z.string().optional(),
      ttlSeconds: z.number().int().min(5).max(900).default(120),
    }),
    async run(c) {
      const master = process.env.DUB_TOKEN;
      if (!master) throw new Error('DUB_TOKEN environment variable is required to mint one-time tokens');
      const res = await fetch(`${c.options.url.replace(/\/$/, '')}/auth/one-time-tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          principal: c.options.principal,
          role: c.options.role,
          ...(c.options.trust ? { trust: c.options.trust } : {}),
          ...(c.options.sandboxId ? { sandboxId: c.options.sandboxId } : {}),
          ttlMs: c.options.ttlSeconds * 1000,
        }),
      });
      if (!res.ok) throw new Error(`Mint failed (HTTP ${res.status}): ${await res.text()}`);
      return res.json();
    },
  });
  auth.command('exchange', {
    description: 'Redeem a one-time token from DUB_ONE_TIME_TOKEN env var for a scoped session token',
    mcp: false,
    options: z.object({
      url: z.string().url().default(process.env.DUB_MCP_URL || 'http://127.0.0.1:7777'),
    }),
    async run(c) {
      const ott = process.env.DUB_ONE_TIME_TOKEN;
      if (!ott) throw new Error('Set DUB_ONE_TIME_TOKEN in the environment (never pass secrets on argv)');
      const res = await fetch(`${c.options.url.replace(/\/$/, '')}/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ott }),
      });
      if (!res.ok) throw new Error(`Exchange failed (HTTP ${res.status}): ${await res.text()}`);
      return res.json();
    },
  });
  return auth;
}

export async function main(argv = process.argv.slice(2)) {
  const cli = createCommands(new Browser());
  cli.command('install', {
    description: 'Download and SHA-256 verify the Dub Chromium binary for this platform',
    mcp: false,
    options: z.object({
      release: z.string().optional().describe('Release tag to download (default: v0.1.0-alpha.1)'),
      baseUrl: z.string().url().optional().describe('Override release base URL'),
      cacheDir: z.string().optional().describe('Override browser cache directory'),
      force: z.boolean().default(false).describe('Re-download even if already cached'),
    }),
    run: c => installBrowser(c.options),
  });
  cli.command(createAuthCli());
  cli.command('serve', {
    description: 'Start the fork and serve MCP at /mcp (with Smithers code mode, Jev, BYO agent triggers, and TS plugins)',
    mcp: false,
    options: z.object({
      port: z.number().int().min(0).max(65535).default(7777),
      host: z.string().default('127.0.0.1'),
      browser: z.string().optional(),
      socket: z.string().optional(),
      profile: z.string().optional(),
      profileName: z.string().optional(),
      headless: z.boolean().default(false),
      connect: z.boolean().default(false),
      plugin: z.string().optional().describe('Comma-separated paths to TypeScript/JS Dub plugin files to load on startup'),
      watch: z.boolean().default(false).describe('Hot-reload loaded plugin files on edit'),
      agentCmd: z.string().optional().describe('BYO agent CLI command (e.g. "claude -p")'),
      agentUrl: z.string().url().optional().describe('BYO agent HTTP endpoint (OpenAI, Anthropic, or webhook)'),
      agentModel: z.string().optional().describe('BYO agent model name'),
      agentFormat: z.enum(['openai', 'anthropic', 'webhook']).optional(),
      printOneTimeToken: z.boolean().default(false).describe('Mint and print a single-use sandbox/agent authentication token on startup'),
      sandboxId: z.string().optional().describe('Sandbox or run identifier bound to the minted one-time token'),
      tokenRole: z.enum(['maintainer', 'contributor', 'sandbox', 'agent', 'viewer']).default('sandbox').describe('Role for the minted one-time token'),
      tokenTrust: z.enum(['trusted', 'untrusted']).optional().describe('Trust tier for the minted one-time token'),
      tokenTtlSeconds: z.number().int().min(5).max(900).default(120).describe('One-time token redemption TTL in seconds'),
      allowedHost: z.string().optional().describe('Comma-separated additional allowed Host headers for cloud proxy listeners'),
    }),
    run: c => runServe(c.options),
  });
  await cli.serve(argv);
}

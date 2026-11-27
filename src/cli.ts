import { z } from 'incur';
import { Browser } from './browser.js';
import { createCommands } from './commands.js';
import { installBrowser } from './download.js';
import { listen } from './http.js';
import { launch } from './launch.js';
import { DubRuntime } from './runtime.js';
import type { AgentAdapterConfig } from './agent-bridge.js';

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
    }),
    async run(c) {
      const session = await launch(c.options);
      let agentCfg: AgentAdapterConfig | undefined;
      if (c.options.agentCmd) {
        const parts = c.options.agentCmd.trim().split(/\s+/);
        agentCfg = { kind: 'cli', command: parts[0]!, args: parts.slice(1) };
      } else if (c.options.agentUrl) {
        agentCfg = {
          kind: 'http',
          url: c.options.agentUrl,
          apiKey: process.env.DUB_AGENT_API_KEY,
          model: c.options.agentModel,
          format: c.options.agentFormat ?? 'webhook',
        };
      }
      const runtime = new DubRuntime(session.browser, { agent: agentCfg });
      try {
        const capabilities = { methods: session.info.methods, tools: session.info.tools };
        const server = await listen(createCommands(session.browser, capabilities, runtime).fetch, {
          ...c.options,
          token: process.env.DUB_TOKEN,
          health: () => session.health(),
        });
        runtime.agent.setMcpEndpoint(`${server.url}/mcp`);
        const loadedPlugins: string[] = [];
        if (c.options.plugin) {
          for (const p of c.options.plugin.split(',').map(s => s.trim()).filter(Boolean)) {
            const loaded = await runtime.plugins.loadFromFile(p, { watch: c.options.watch });
            loadedPlugins.push(loaded.name);
          }
        }
        let stopping = false;
        const stop = async () => {
          if (stopping) return; stopping = true;
          try { await runtime.close(); } catch (error) { console.error(error); }
          try { await server.close(); }
          catch (error) { console.error(error); process.exitCode = 1; }
          finally {
            try { await session.close(); }
            catch (error) { console.error(error); process.exitCode = 1; }
          }
          process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return {
          endpoint: `${server.url}/mcp`,
          socket: session.browser.native.socket,
          browser: session.info,
          plugins: loadedPlugins,
          agent: runtime.agent.describe(),
          jev: { configured: runtime.jev.isConfigured, model: runtime.jev.modelId },
        };
      } catch (error) {
        await runtime.close().catch(() => {});
        await session.close();
        throw error;
      }
    },
  });
  await cli.serve(argv);
}

import { z } from 'incur';
import { Browser } from './browser.js';
import { createCommands } from './commands.js';
import { installBrowser } from './download.js';
import { listen } from './http.js';
import { launch } from './launch.js';

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
    description: 'Start the fork and serve MCP at /mcp', mcp: false,
    options: z.object({
      port: z.number().int().min(0).max(65535).default(7777), host: z.string().default('127.0.0.1'),
      browser: z.string().optional(), socket: z.string().optional(), profile: z.string().optional(),
      profileName: z.string().optional(), headless: z.boolean().default(false), connect: z.boolean().default(false),
    }),
    async run(c) {
      const session = await launch(c.options);
      try {
        const capabilities = { methods: session.info.methods, tools: session.info.tools };
        const server = await listen(createCommands(session.browser, capabilities).fetch, {
          ...c.options,
          token: process.env.DUB_TOKEN,
          health: () => session.health(),
        });
        let stopping = false;
        const stop = async () => {
          if (stopping) return; stopping = true;
          try { await server.close(); }
          catch (error) { console.error(error); process.exitCode = 1; }
          finally {
            try { await session.close(); }
            catch (error) { console.error(error); process.exitCode = 1; }
          }
          process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return { endpoint: `${server.url}/mcp`, socket: session.browser.native.socket, browser: session.info };
      } catch (error) { await session.close(); throw error; }
    },
  });
  await cli.serve(argv);
}

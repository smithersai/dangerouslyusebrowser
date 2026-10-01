import { z } from 'incur';
import { Browser } from './browser.js';
import { createCommands } from './commands.js';
import { listen } from './http.js';
import { launch } from './launch.js';

export async function main(argv = process.argv.slice(2)) {
  const cli = createCommands(new Browser());
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
        const server = await listen(createCommands(session.browser).fetch, { ...c.options, token: process.env.DUB_TOKEN });
        let stopping = false;
        const stop = async () => {
          if (stopping) return; stopping = true;
          try { await server.close(); await session.close(); }
          catch (error) { console.error(error); process.exitCode = 1; }
          process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return { endpoint: `${server.url}/mcp`, socket: session.browser.native.socket, browser: await session.browser.info() };
      } catch (error) { await session.close(); throw error; }
    },
  });
  await cli.serve(argv);
}

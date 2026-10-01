import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { isIP } from 'node:net';

export const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';
function authorized(value: string | undefined, token: string) {
  const supplied = Buffer.from(value || ''); const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new Error('Request body exceeds 16 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function listen(fetch: (req: Request) => Promise<Response>, options: { host?: string; port?: number; token?: string } = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host) && !options.token) throw new Error('Non-loopback listeners require DUB_TOKEN');
  if (options.token !== undefined && options.token.length < 24) throw new Error('DUB_TOKEN must contain at least 24 characters');
  if (!isIP(host) && host !== 'localhost') throw new Error('Use an IP address or localhost for --host');
  let origin = '';
  let allowedHosts = new Set<string>();
  const server = createServer(async (req, res) => {
    try {
      if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase())) { res.writeHead(403).end('Host not allowed'); return; }
      if (req.headers.origin) {
        let same = false;
        try { const u = new URL(req.headers.origin); same = u.protocol === 'http:' && allowedHosts.has(u.host.toLowerCase()); } catch {}
        if (!same) { res.writeHead(403).end('Origin not allowed'); return; }
      }
      if (options.token && !authorized(req.headers.authorization, options.token)) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('Unauthorized'); return; }
      const pathname = new URL(req.url ?? '/', origin).pathname;
      if (pathname === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"product":"Dub","ok":true}'); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const request = new Request(new URL(req.url ?? '/', origin), { method: req.method, headers, signal: controller.signal,
        ...(['GET', 'HEAD'].includes(req.method ?? 'GET') ? {} : { body: await body(req) }) });
      const response = await fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
      else res.end();
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
      else res.destroy();
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.listen(options.port ?? 7777, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected HTTP listener address');
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  allowedHosts = new Set([new URL(origin).host]);
  if (isLoopback(host)) for (const h of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(`${h}:${address.port}`);
  return { url: origin, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { isIP } from 'node:net';
import {
  AuthError,
  TokenAuthority,
  type AuthPrincipal,
  type AuthScope,
  type MintOneTimeTokenOptions,
  type MintedOneTimeToken,
  type PrincipalRole,
  type TrustLevel,
} from './auth.js';

export const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/**
 * Privileged MCP tool names denied at the HTTP boundary whenever a request
 * authenticates with `trust: "untrusted"`. Untrusted principals are encouraged
 * to run read/inspect/sandboxed tools without accessing host profiles, plugin
 * filesystem loading, or process termination.
 */
export const UNTRUSTED_FORBIDDEN_TOOLS = new Set([
  'profile_attach',
  'plugin_load',
  'plugin_unload',
  'plugin_reload',
  'quit',
]);

async function readBody(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Request body exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res
    .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders })
    .end(JSON.stringify(payload));
}

function parseOriginHost(originHeader: string): string | null {
  try {
    const u = new URL(originHeader);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

function buildAllowedHosts(origin: string, host: string, port: number, extra?: string[]): Set<string> {
  const allowedHosts = new Set([new URL(origin).host]);
  if (isLoopback(host)) {
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(`${h}:${port}`);
  }
  if (extra) {
    for (const h of extra) {
      const normalized = h.toLowerCase();
      allowedHosts.add(normalized.includes(':') ? normalized : `${normalized}:${port}`);
    }
  }
  return allowedHosts;
}

function checkUntrustedMcpGate(principal: AuthPrincipal | null, pathname: string, bodyBuf: Buffer | undefined): { id: unknown; tool: string } | null {
  if (!principal || principal.trust !== 'untrusted' || pathname !== '/mcp' || !bodyBuf || bodyBuf.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(bodyBuf.toString('utf8'));
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of messages) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as { id?: unknown; method?: unknown; params?: { name?: unknown } };
      if (msg.method === 'tools/call' && typeof msg.params?.name === 'string' && UNTRUSTED_FORBIDDEN_TOOLS.has(msg.params.name)) {
        return { id: msg.id ?? null, tool: msg.params.name };
      }
    }
  } catch {
    // Non-JSON payloads are handled downstream by incur MCP parser.
  }
  return null;
}

export type ListenOptions = {
  host?: string;
  port?: number;
  token?: string;
  authority?: TokenAuthority;
  /** Require bearer/session auth even on loopback (e.g. cloud sandbox mode). */
  requireAuth?: boolean;
  /** Mint an initial one-time bootstrap token at startup for a sandbox or agent. */
  bootstrapToken?: MintOneTimeTokenOptions;
  allowedHosts?: string[];
  health?: () => { ok: boolean; [key: string]: unknown };
};

export type ListenHandle = {
  url: string;
  authority: TokenAuthority;
  bootstrap?: MintedOneTimeToken;
  mintOneTimeToken: (options: MintOneTimeTokenOptions) => MintedOneTimeToken;
  close: () => Promise<void>;
};

async function handleExchange(req: IncomingMessage, res: ServerResponse, authority: TokenAuthority): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, 64 * 1024);
  } catch {
    sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 64 KiB limit' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'Expected JSON body with one-time token' } });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'Expected JSON object with one-time token' } });
    return;
  }
  const token = (parsed as { token?: unknown }).token;
  try {
    const redeemed = authority.redeemOneTimeToken(typeof token === 'string' ? token : '');
    sendJson(res, 200, { sessionToken: redeemed.sessionToken, principal: redeemed.principal });
  } catch (error) {
    if (error instanceof AuthError) {
      sendJson(res, error.code === 'OTT_ALREADY_USED' ? 409 : 401, { error: { code: error.code, message: error.message } });
    } else {
      sendJson(res, 401, { error: { code: 'OTT_INVALID', message: 'Unable to redeem one-time token' } });
    }
  }
}

async function handleMintRoute(
  req: IncomingMessage,
  res: ServerResponse,
  authority: TokenAuthority,
  principal: AuthPrincipal | null,
  authRequired: boolean
): Promise<void> {
  if (authRequired && (!principal || principal.trust !== 'trusted' || !principal.scopes.includes('auth:mint'))) {
    sendJson(res, principal ? 403 : 401, {
      error: { code: principal ? 'AUTH_FORBIDDEN' : 'UNAUTHORIZED', message: 'Trusted auth:mint scope required' },
    });
    return;
  }
  let bodyObj: Record<string, unknown>;
  try {
    bodyObj = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { code: 'INVALID_JSON', message: 'Invalid JSON request body' } });
    return;
  }
  try {
    const minted = authority.mintOneTimeToken({
      principal: typeof bodyObj.principal === 'string' ? bodyObj.principal : '',
      role: typeof bodyObj.role === 'string' ? (bodyObj.role as PrincipalRole) : undefined,
      trust: typeof bodyObj.trust === 'string' ? (bodyObj.trust as TrustLevel) : undefined,
      scopes: Array.isArray(bodyObj.scopes) ? (bodyObj.scopes as AuthScope[]) : undefined,
      sandboxId: typeof bodyObj.sandboxId === 'string' ? bodyObj.sandboxId : undefined,
      ttlMs: typeof bodyObj.ttlMs === 'number' ? bodyObj.ttlMs : undefined,
      sessionTtlMs: typeof bodyObj.sessionTtlMs === 'number' ? bodyObj.sessionTtlMs : undefined,
      issuedBy: principal?.principal ?? 'local-loopback',
    });
    sendJson(res, 201, minted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to mint one-time token';
    const code = error instanceof AuthError ? error.code : 'AUTH_INVALID_OPTIONS';
    sendJson(res, 400, { error: { code, message } });
  }
}

const AUTH_ALLOWED_METHODS: Record<string, string> = {
  '/auth/exchange': 'POST',
  '/auth/one-time-tokens': 'POST',
  '/auth/whoami': 'GET',
  '/auth/revoke': 'POST',
  '/auth/audit': 'GET',
};

async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  authority: TokenAuthority,
  principal: AuthPrincipal | null,
  authRequired: boolean
): Promise<boolean> {
  const allowedMethod = AUTH_ALLOWED_METHODS[pathname];
  if (allowedMethod && req.method !== allowedMethod) {
    sendJson(
      res,
      405,
      { error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${allowedMethod} for ${pathname}` } },
      { allow: allowedMethod }
    );
    return true;
  }
  if (pathname === '/auth/exchange') {
    await handleExchange(req, res, authority);
    return true;
  }
  if (pathname === '/auth/one-time-tokens') {
    await handleMintRoute(req, res, authority, principal, authRequired);
    return true;
  }
  if (pathname === '/auth/whoami') {
    if (authRequired && !principal) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { 'www-authenticate': 'Bearer' });
      return true;
    }
    sendJson(res, 200, {
      authenticated: principal !== null,
      principal: principal ?? {
        tokenId: 'loopback-anonymous',
        principal: 'local-loopback',
        role: 'maintainer',
        trust: 'trusted',
        scopes: ['mcp:read', 'mcp:write'],
        issuedAt: new Date(0).toISOString(),
        expiresAt: null,
        kind: 'static',
      },
    });
    return true;
  }
  if (pathname === '/auth/revoke') {
    if (!principal || principal.kind !== 'session') {
      sendJson(res, 400, { error: { code: 'NO_REVOCABLE_SESSION', message: 'Active session token required' } });
      return true;
    }
    sendJson(res, 200, { revoked: authority.revokeSession(principal.tokenId), tokenId: principal.tokenId });
    return true;
  }
  if (pathname === '/auth/audit') {
    if (authRequired && (!principal || principal.trust !== 'trusted' || !principal.scopes.includes('auth:mint'))) {
      sendJson(res, principal ? 403 : 401, {
        error: { code: principal ? 'AUTH_FORBIDDEN' : 'UNAUTHORIZED', message: 'Trusted auth:mint scope required' },
      });
      return true;
    }
    sendJson(res, 200, { activeSessions: authority.activeSessionCount(), events: authority.auditLog() });
    return true;
  }
  return false;
}

async function proxyMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  pathname: string,
  principal: AuthPrincipal | null,
  fetchFn: (req: Request) => Promise<Response>
): Promise<void> {
  const bodyBuf = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req);
  const blocked = checkUntrustedMcpGate(principal, pathname, bodyBuf);
  if (blocked) {
    sendJson(
      res,
      403,
      {
        jsonrpc: '2.0',
        id: blocked.id,
        error: {
          code: -32003,
          message: `Untrusted principal cannot invoke privileged tool "${blocked.tool}"`,
        },
      },
      { 'x-dub-trust': 'untrusted' }
    );
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  if (principal) {
    headers.set('x-dub-principal', principal.principal);
    headers.set('x-dub-role', principal.role);
    headers.set('x-dub-trust', principal.trust);
    headers.set('x-dub-scopes', principal.scopes.join(','));
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const request = new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    signal: controller.signal,
    ...(bodyBuf ? { body: new Uint8Array(bodyBuf) } : {}),
  });
  const response = await fetchFn(request);
  const outHeaders = Object.fromEntries(response.headers);
  if (principal) outHeaders['x-dub-trust'] = principal.trust;
  res.writeHead(response.status, outHeaders);
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
  } else {
    res.end();
  }
}

export async function listen(fetchFn: (req: Request) => Promise<Response>, options: ListenOptions = {}): Promise<ListenHandle> {
  const host = options.host ?? '127.0.0.1';
  const authority = options.authority ?? new TokenAuthority({ staticToken: options.token });
  const bootstrap = options.bootstrapToken ? authority.mintOneTimeToken(options.bootstrapToken) : undefined;
  const authRequired = Boolean(options.requireAuth || options.token || bootstrap || authority.requiresAuth);

  if (!isLoopback(host) && !authRequired) {
    throw new Error('Non-loopback listeners require DUB_TOKEN or one-time token authentication');
  }
  if (!isIP(host) && host !== 'localhost') {
    throw new Error('Use an IP address or localhost for --host');
  }

  let origin = '';
  let allowedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase())) {
        res.writeHead(403).end('Host not allowed');
        return;
      }
      if (req.headers.origin) {
        const originHost = parseOriginHost(req.headers.origin);
        if (!originHost || !allowedHosts.has(originHost)) {
          res.writeHead(403).end('Origin not allowed');
          return;
        }
      }
      const pathname = new URL(req.url ?? '/', origin).pathname;
      const principal = authority.verifyAuthorization(req.headers.authorization);
      if (pathname.startsWith('/auth/') && (await handleAuthRoutes(req, res, pathname, authority, principal, authRequired))) {
        return;
      }
      if (authRequired && !principal) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('Unauthorized');
        return;
      }
      if (pathname === '/health' && req.method === 'GET') {
        const status = options.health ? options.health() : { ok: true };
        sendJson(res, status.ok ? 200 : 503, {
          product: 'Dub',
          auth: { required: authRequired, activeSessions: authority.activeSessionCount() },
          ...status,
        });
        return;
      }
      await proxyMcpRequest(req, res, origin, pathname, principal, fetchFn);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Request failed' });
      } else {
        res.destroy();
      }
    }
  });

  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.listen(options.port ?? 7777, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected HTTP listener address');
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  allowedHosts = buildAllowedHosts(origin, host, address.port, options.allowedHosts);

  return {
    url: origin,
    authority,
    ...(bootstrap ? { bootstrap } : {}),
    mintOneTimeToken: (opts: MintOneTimeTokenOptions) => authority.mintOneTimeToken(opts),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
    },
  };
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type PrincipalRole = 'maintainer' | 'contributor' | 'sandbox' | 'agent' | 'viewer';
export type TrustLevel = 'trusted' | 'untrusted';

export type AuthScope =
  | 'mcp:read'
  | 'mcp:write'
  | 'mcp:admin'
  | 'auth:mint'
  | 'cache:read'
  | 'cache:write'
  | 'plugin:manage'
  | 'profile:attach';

export type MintOneTimeTokenOptions = {
  principal: string;
  role?: PrincipalRole;
  trust?: TrustLevel;
  scopes?: AuthScope[];
  sandboxId?: string;
  ttlMs?: number;
  sessionTtlMs?: number;
  issuedBy?: string;
};

export type MintedOneTimeToken = {
  oneTimeToken: string;
  tokenId: string;
  principal: string;
  role: PrincipalRole;
  trust: TrustLevel;
  scopes: AuthScope[];
  sandboxId?: string;
  expiresAt: string;
  sessionTtlMs: number;
};

export type AuthPrincipal = {
  tokenId: string;
  principal: string;
  role: PrincipalRole;
  trust: TrustLevel;
  scopes: AuthScope[];
  sandboxId?: string;
  issuedAt: string;
  expiresAt: string | null;
  kind: 'static' | 'session';
};

export type RedeemedSession = {
  sessionToken: string;
  principal: AuthPrincipal;
};

export type AuthAuditEvent = {
  at: string;
  action: 'mint' | 'redeem' | 'replay_rejected' | 'expired_rejected' | 'invalid_rejected' | 'revoke' | 'denied';
  tokenId?: string;
  principal?: string;
  role?: PrincipalRole;
  trust?: TrustLevel;
  sandboxId?: string;
  detail?: string;
};

export class AuthError extends Error {
  constructor(
    public readonly code: 'OTT_INVALID' | 'OTT_EXPIRED' | 'OTT_ALREADY_USED' | 'AUTH_FORBIDDEN' | 'AUTH_INVALID_OPTIONS',
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const DEFAULT_OTT_TTL_MS = 120_000;
const MAX_OTT_TTL_MS = 15 * 60_000;
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_AUDIT_ENTRIES = 128;

const DEFAULT_SCOPES_BY_TRUST: Record<TrustLevel, AuthScope[]> = {
  trusted: ['mcp:read', 'mcp:write', 'cache:read', 'cache:write', 'plugin:manage'],
  untrusted: ['mcp:read', 'cache:read'],
};

const PRIVILEGED_SCOPES = new Set<AuthScope>(['mcp:admin', 'auth:mint', 'cache:write', 'plugin:manage', 'profile:attach']);

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function constantTimeBufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

type StoredOneTimeToken = {
  tokenId: string;
  digest: Buffer;
  principal: string;
  role: PrincipalRole;
  trust: TrustLevel;
  scopes: AuthScope[];
  sandboxId?: string;
  expiresAtMs: number;
  sessionTtlMs: number;
  used: boolean;
};

type StoredSessionToken = {
  tokenId: string;
  digest: Buffer;
  principal: AuthPrincipal;
  expiresAtMs: number;
  revoked: boolean;
};

/**
 * Attenuated token authority for Dub's cloud-authenticated MCP server.
 *
 * Security invariants:
 * - Raw tokens are returned once on mint/exchange and stored strictly as SHA-256 digests.
 * - One-time tokens (`dub_ott_...`) redeem atomically once; replays are rejected and audited.
 * - Untrusted principals can never hold privileged scopes (`cache:write`, `auth:mint`, `mcp:admin`,
 *   `plugin:manage`, `profile:attach`) regardless of requested scopes.
 * - All token comparisons execute in constant time via `crypto.timingSafeEqual`.
 */
export class TokenAuthority {
  private readonly staticDigest?: Buffer;
  private readonly oneTimeTokens = new Map<string, StoredOneTimeToken>();
  private readonly sessions = new Map<string, StoredSessionToken>();
  private readonly auditRing: AuthAuditEvent[] = [];

  constructor(options: { staticToken?: string } = {}) {
    if (options.staticToken !== undefined) {
      if (options.staticToken.length < 24) {
        throw new AuthError('AUTH_INVALID_OPTIONS', 'DUB_TOKEN must contain at least 24 characters');
      }
      this.staticDigest = sha256(`Bearer ${options.staticToken}`);
    }
  }

  get requiresAuth(): boolean {
    return this.staticDigest !== undefined || this.oneTimeTokens.size > 0 || this.sessions.size > 0;
  }

  private record(event: Omit<AuthAuditEvent, 'at'>): void {
    this.auditRing.push({ at: new Date().toISOString(), ...event });
    if (this.auditRing.length > MAX_AUDIT_ENTRIES) {
      this.auditRing.splice(0, this.auditRing.length - MAX_AUDIT_ENTRIES);
    }
  }

  private pruneExpired(now = Date.now()): void {
    for (const [id, entry] of this.oneTimeTokens) {
      if (entry.expiresAtMs + 60_000 < now) this.oneTimeTokens.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (session.revoked || session.expiresAtMs < now) this.sessions.delete(id);
    }
  }

  mintOneTimeToken(options: MintOneTimeTokenOptions): MintedOneTimeToken {
    const principal = options.principal.trim();
    if (!principal || principal.length > 128) {
      throw new AuthError('AUTH_INVALID_OPTIONS', 'principal must be a non-empty string up to 128 characters');
    }
    const role: PrincipalRole = options.role ?? 'sandbox';
    const trust: TrustLevel =
      options.trust ?? (role === 'maintainer' || role === 'sandbox' ? 'trusted' : 'untrusted');
    if (trust === 'trusted' && (role === 'viewer' || role === 'contributor')) {
      throw new AuthError('AUTH_INVALID_OPTIONS', `Role ${role} cannot be minted with trusted execution privileges`);
    }

    const ttlMs = options.ttlMs ?? DEFAULT_OTT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_OTT_TTL_MS) {
      throw new AuthError('AUTH_INVALID_OPTIONS', `One-time token ttlMs must be between 1000 and ${MAX_OTT_TTL_MS}`);
    }
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > MAX_SESSION_TTL_MS) {
      throw new AuthError('AUTH_INVALID_OPTIONS', `Session ttlMs must be between 1000 and ${MAX_SESSION_TTL_MS}`);
    }

    const requestedScopes = options.scopes ?? DEFAULT_SCOPES_BY_TRUST[trust];
    const effectiveScopes = Array.from(
      new Set(
        trust === 'untrusted'
          ? requestedScopes.filter(scope => !PRIVILEGED_SCOPES.has(scope))
          : requestedScopes
      )
    );
    if (effectiveScopes.length === 0) effectiveScopes.push('mcp:read');

    this.pruneExpired();
    const tokenId = `ott_${randomBytes(8).toString('hex')}`;
    const oneTimeToken = `dub_ott_${randomBytes(32).toString('base64url')}`;
    const expiresAtMs = Date.now() + ttlMs;

    this.oneTimeTokens.set(tokenId, {
      tokenId,
      digest: sha256(oneTimeToken),
      principal,
      role,
      trust,
      scopes: effectiveScopes,
      sandboxId: options.sandboxId,
      expiresAtMs,
      sessionTtlMs,
      used: false,
    });

    this.record({
      action: 'mint',
      tokenId,
      principal,
      role,
      trust,
      sandboxId: options.sandboxId,
      detail: options.issuedBy ? `issuedBy=${options.issuedBy}` : undefined,
    });

    return {
      oneTimeToken,
      tokenId,
      principal,
      role,
      trust,
      scopes: effectiveScopes,
      ...(options.sandboxId ? { sandboxId: options.sandboxId } : {}),
      expiresAt: new Date(expiresAtMs).toISOString(),
      sessionTtlMs,
    };
  }

  redeemOneTimeToken(rawToken: string): RedeemedSession {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('dub_ott_') || rawToken.length < 40) {
      this.record({ action: 'invalid_rejected', detail: 'malformed one-time token' });
      throw new AuthError('OTT_INVALID', 'Invalid one-time token');
    }
    const suppliedDigest = sha256(rawToken);
    let matched: StoredOneTimeToken | undefined;
    for (const entry of this.oneTimeTokens.values()) {
      if (constantTimeBufferEqual(entry.digest, suppliedDigest)) {
        matched = entry;
      }
    }
    if (!matched) {
      this.record({ action: 'invalid_rejected', detail: 'unknown one-time token' });
      throw new AuthError('OTT_INVALID', 'Unknown one-time token');
    }
    if (matched.used) {
      this.record({
        action: 'replay_rejected',
        tokenId: matched.tokenId,
        principal: matched.principal,
        role: matched.role,
        trust: matched.trust,
        sandboxId: matched.sandboxId,
      });
      throw new AuthError('OTT_ALREADY_USED', 'One-time token has already been redeemed');
    }
    const now = Date.now();
    if (now > matched.expiresAtMs) {
      matched.used = true;
      this.record({
        action: 'expired_rejected',
        tokenId: matched.tokenId,
        principal: matched.principal,
        role: matched.role,
        trust: matched.trust,
        sandboxId: matched.sandboxId,
      });
      throw new AuthError('OTT_EXPIRED', 'One-time token has expired');
    }

    // Mark used atomically before creating the session token.
    matched.used = true;

    const sessionId = `ses_${randomBytes(8).toString('hex')}`;
    const sessionToken = `dub_ses_${randomBytes(32).toString('base64url')}`;
    const expiresAtMs = now + matched.sessionTtlMs;
    const principal: AuthPrincipal = {
      tokenId: sessionId,
      principal: matched.principal,
      role: matched.role,
      trust: matched.trust,
      scopes: [...matched.scopes],
      ...(matched.sandboxId ? { sandboxId: matched.sandboxId } : {}),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      kind: 'session',
    };

    this.sessions.set(sessionId, {
      tokenId: sessionId,
      digest: sha256(`Bearer ${sessionToken}`),
      principal,
      expiresAtMs,
      revoked: false,
    });

    this.record({
      action: 'redeem',
      tokenId: matched.tokenId,
      principal: principal.principal,
      role: principal.role,
      trust: principal.trust,
      sandboxId: principal.sandboxId,
      detail: `session=${sessionId}`,
    });

    return { sessionToken, principal };
  }

  verifyAuthorization(header: string | undefined): AuthPrincipal | null {
    if (!header || !header.startsWith('Bearer ')) return null;
    const suppliedDigest = sha256(header);

    if (this.staticDigest && constantTimeBufferEqual(this.staticDigest, suppliedDigest)) {
      return {
        tokenId: 'static',
        principal: 'maintainer',
        role: 'maintainer',
        trust: 'trusted',
        scopes: ['mcp:read', 'mcp:write', 'mcp:admin', 'auth:mint', 'cache:read', 'cache:write', 'plugin:manage', 'profile:attach'],
        issuedAt: new Date(0).toISOString(),
        expiresAt: null,
        kind: 'static',
      };
    }

    const now = Date.now();
    let matched: StoredSessionToken | undefined;
    for (const session of this.sessions.values()) {
      if (constantTimeBufferEqual(session.digest, suppliedDigest)) {
        matched = session;
      }
    }
    if (!matched || matched.revoked || now > matched.expiresAtMs) {
      return null;
    }
    return matched.principal;
  }

  revokeSession(tokenId: string): boolean {
    const session = this.sessions.get(tokenId);
    if (!session || session.revoked) return false;
    session.revoked = true;
    this.sessions.delete(tokenId);
    this.record({
      action: 'revoke',
      tokenId,
      principal: session.principal.principal,
      role: session.principal.role,
      trust: session.principal.trust,
    });
    return true;
  }

  auditLog(): AuthAuditEvent[] {
    return this.auditRing.map(entry => ({ ...entry }));
  }

  activeSessionCount(): number {
    this.pruneExpired();
    return this.sessions.size;
  }
}

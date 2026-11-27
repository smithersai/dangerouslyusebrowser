import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, TokenAuthority, listen } from '../dist/index.js';

test('TokenAuthority mints single-use one-time tokens and rejects replays atomically', () => {
  const authority = new TokenAuthority();
  const minted = authority.mintOneTimeToken({
    principal: 'sandbox:ci-42',
    role: 'sandbox',
    sandboxId: 'sbx-42',
    ttlMs: 30_000,
  });

  assert.match(minted.oneTimeToken, /^dub_ott_[A-Za-z0-9_-]{32,}$/);
  assert.equal(minted.role, 'sandbox');
  assert.equal(minted.trust, 'trusted');
  assert.ok(minted.scopes.includes('cache:write'));

  const redeemed = authority.redeemOneTimeToken(minted.oneTimeToken);
  assert.match(redeemed.sessionToken, /^dub_ses_[A-Za-z0-9_-]{32,}$/);
  assert.equal(redeemed.principal.principal, 'sandbox:ci-42');
  assert.equal(redeemed.principal.sandboxId, 'sbx-42');

  assert.throws(
    () => authority.redeemOneTimeToken(minted.oneTimeToken),
    error => error instanceof AuthError && error.code === 'OTT_ALREADY_USED'
  );

  const verified = authority.verifyAuthorization(`Bearer ${redeemed.sessionToken}`);
  assert.equal(verified?.principal, 'sandbox:ci-42');
  assert.equal(verified?.trust, 'trusted');

  assert.equal(authority.revokeSession(redeemed.principal.tokenId), true);
  assert.equal(authority.verifyAuthorization(`Bearer ${redeemed.sessionToken}`), null);
});

test('TokenAuthority attenuates untrusted principals and blocks cache poisoning scopes', () => {
  const authority = new TokenAuthority();
  const minted = authority.mintOneTimeToken({
    principal: 'contributor:alice',
    role: 'contributor',
    scopes: ['mcp:read', 'mcp:write', 'cache:read', 'cache:write', 'auth:mint', 'mcp:admin', 'plugin:manage', 'profile:attach'],
  });

  assert.equal(minted.trust, 'untrusted');
  assert.deepEqual(minted.scopes.sort(), ['cache:read', 'mcp:read', 'mcp:write']);
  assert.ok(!minted.scopes.includes('cache:write'));
  assert.ok(!minted.scopes.includes('auth:mint'));
  assert.ok(!minted.scopes.includes('mcp:admin'));
  assert.ok(!minted.scopes.includes('plugin:manage'));
  assert.ok(!minted.scopes.includes('profile:attach'));

  assert.throws(
    () => authority.mintOneTimeToken({ principal: 'contributor:bob', role: 'contributor', trust: 'trusted' }),
    error => error instanceof AuthError && error.code === 'AUTH_INVALID_OPTIONS'
  );
  assert.throws(
    () => authority.mintOneTimeToken({ principal: 'viewer:eve', role: 'viewer', trust: 'trusted' }),
    error => error instanceof AuthError && error.code === 'AUTH_INVALID_OPTIONS'
  );
});

test('TokenAuthority rejects expired one-time tokens and records sanitized audit log', async () => {
  const authority = new TokenAuthority();
  const minted = authority.mintOneTimeToken({
    principal: 'agent:ephemeral',
    role: 'agent',
    ttlMs: 1_000,
  });

  // Backdate expiry check by waiting past 1s minimum TTL.
  await delay(1_050);
  assert.throws(
    () => authority.redeemOneTimeToken(minted.oneTimeToken),
    error => error instanceof AuthError && error.code === 'OTT_EXPIRED'
  );

  const events = authority.auditLog();
  assert.ok(events.some(e => e.action === 'mint' && e.principal === 'agent:ephemeral'));
  assert.ok(events.some(e => e.action === 'expired_rejected' && e.principal === 'agent:ephemeral'));
  assert.equal(JSON.stringify(events).includes(minted.oneTimeToken), false);
});

test('HTTP MCP listener supports one-time token exchange, principal headers, whoami, minting, and revoke', async t => {
  const staticToken = 'dub-maintainer-master-token-0123456789';
  let observedTrust = '';
  let observedRole = '';

  const server = await listen(
    async req => {
      observedTrust = req.headers.get('x-dub-trust') ?? '';
      observedRole = req.headers.get('x-dub-role') ?? '';
      return Response.json({ ok: true, trust: observedTrust, role: observedRole });
    },
    {
      port: 0,
      token: staticToken,
      bootstrapToken: {
        principal: 'sandbox:bootstrap-1',
        role: 'sandbox',
        sandboxId: 'sbx-boot',
        ttlMs: 60_000,
      },
    }
  );
  t.after(() => server.close());

  assert.ok(server.bootstrap?.oneTimeToken.startsWith('dub_ott_'));

  // Exchange bootstrap one-time token for a scoped session token
  const exchangeRes = await fetch(`${server.url}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: server.bootstrap.oneTimeToken }),
  });
  assert.equal(exchangeRes.status, 200);
  const { sessionToken, principal } = await exchangeRes.json();
  assert.match(sessionToken, /^dub_ses_/);
  assert.equal(principal.trust, 'trusted');
  assert.equal(principal.sandboxId, 'sbx-boot');

  // Replay fails with 409 Conflict
  const replayRes = await fetch(`${server.url}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: server.bootstrap.oneTimeToken }),
  });
  assert.equal(replayRes.status, 409);

  // Authenticated request succeeds and forwards verified trust headers
  const mcpRes = await fetch(`${server.url}/mcp`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(mcpRes.status, 200);
  assert.equal(mcpRes.headers.get('x-dub-trust'), 'trusted');
  assert.equal(observedTrust, 'trusted');
  assert.equal(observedRole, 'sandbox');

  // Maintainer static token mints an untrusted contributor token via HTTP
  const mintRes = await fetch(`${server.url}/auth/one-time-tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${staticToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      principal: 'pr-author:bob',
      role: 'contributor',
      scopes: ['mcp:read', 'cache:read', 'cache:write', 'auth:mint'],
    }),
  });
  assert.equal(mintRes.status, 201);
  const contribOtt = await mintRes.json();
  assert.equal(contribOtt.trust, 'untrusted');
  assert.ok(!contribOtt.scopes.includes('cache:write'));
  assert.ok(!contribOtt.scopes.includes('auth:mint'));

  // Contributor redeems one-time token, can read /auth/whoami, cannot mint tokens or view audit
  const contribExch = await fetch(`${server.url}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: contribOtt.oneTimeToken }),
  });
  assert.equal(contribExch.status, 200);
  const { sessionToken: contribSession } = await contribExch.json();

  const whoamiRes = await fetch(`${server.url}/auth/whoami`, {
    headers: { authorization: `Bearer ${contribSession}` },
  });
  assert.equal(whoamiRes.status, 200);
  const whoami = await whoamiRes.json();
  assert.equal(whoami.principal.trust, 'untrusted');

  const forbiddenMint = await fetch(`${server.url}/auth/one-time-tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${contribSession}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ principal: 'escalation-attempt', role: 'maintainer' }),
  });
  assert.equal(forbiddenMint.status, 403);

  const forbiddenAudit = await fetch(`${server.url}/auth/audit`, {
    headers: { authorization: `Bearer ${contribSession}` },
  });
  assert.equal(forbiddenAudit.status, 403);

  // Maintainer can read audit log, and no secret token bytes appear in it
  const auditRes = await fetch(`${server.url}/auth/audit`, {
    headers: { authorization: `Bearer ${staticToken}` },
  });
  assert.equal(auditRes.status, 200);
  const auditBody = await auditRes.text();
  assert.equal(auditBody.includes(server.bootstrap.oneTimeToken), false);
  assert.equal(auditBody.includes(sessionToken), false);
  assert.equal(auditBody.includes(contribSession), false);

  // Revoke contributor session immediately
  const revokeRes = await fetch(`${server.url}/auth/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${contribSession}` },
  });
  assert.equal(revokeRes.status, 200);
  const afterRevoke = await fetch(`${server.url}/auth/whoami`, {
    headers: { authorization: `Bearer ${contribSession}` },
  });
  assert.equal(afterRevoke.status, 401);
});

test('HTTP MCP boundary blocks untrusted principals from invoking privileged tools while allowing safe reads', async t => {
  const staticToken = 'dub-maintainer-master-token-0123456789';
  let forwardedCalls = 0;

  const server = await listen(
    async req => {
      forwardedCalls++;
      return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true, trust: req.headers.get('x-dub-trust') } });
    },
    { port: 0, token: staticToken }
  );
  t.after(() => server.close());

  const contribOtt = server.mintOneTimeToken({
    principal: 'contributor:carol',
    role: 'contributor',
    ttlMs: 30_000,
  });
  const { sessionToken } = server.authority.redeemOneTimeToken(contribOtt.oneTimeToken);

  // Privileged tool calls MUST be blocked at the HTTP boundary before reaching incur/Chromium
  for (const forbidden of ['profile_attach', 'plugin_load', 'plugin_unload', 'plugin_reload', 'quit']) {
    const blocked = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: forbidden, arguments: {} } }),
    });
    assert.equal(blocked.status, 403, `Expected 403 for untrusted tool ${forbidden}`);
    const payload = await blocked.json();
    assert.equal(payload.error.code, -32003);
  }
  assert.equal(forwardedCalls, 0);

  // Safe non-privileged tool call succeeds for untrusted principal
  const allowed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'tabs_list', arguments: {} } }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(forwardedCalls, 1);

  // Trusted maintainer can call privileged tools
  const maintainerAllowed = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${staticToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'plugin_load', arguments: {} } }),
  });
  assert.equal(maintainerAllowed.status, 200);
  assert.equal(forwardedCalls, 2);
});

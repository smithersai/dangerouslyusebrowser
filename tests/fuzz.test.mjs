import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  AuthError,
  Browser,
  NativeBridge,
  TokenAuthority,
  createCommands,
  duration,
  installBrowser,
  listen,
  parseSha256Sums,
  resolveInstalledBrowser,
} from '../dist/index.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

test('fuzz: compiled N-API bridge survives 120 malformed, truncated, oversized & concurrent frames', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dub-fuzz-ipc-'));
  const socketPath = join(dir, 'fuzz.sock');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rng = mulberry32(0xdecafbad);
  let reqCount = 0;

  const server = createNetServer(conn => {
    conn.on('error', () => {});
    let buf = Buffer.alloc(0);
    conn.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      const idx = reqCount++;
      const mode = idx % 8;

      if (mode === 0) {
        // Valid echo response
        conn.end(frame(JSON.stringify({ protocol: 1, id: msg.id, result: { ok: true, idx } })));
      } else if (mode === 1) {
        // Wrong ID
        conn.end(frame(JSON.stringify({ protocol: 1, id: 'wrong-id', result: { ok: true } })));
      } else if (mode === 2) {
        // Invalid JSON payload
        conn.end(frame('{not valid json!!!'));
      } else if (mode === 3) {
        // Premature EOF mid-frame
        const f = frame(JSON.stringify({ protocol: 1, id: msg.id, result: { ok: true } }));
        conn.end(f.subarray(0, Math.max(2, Math.floor(f.length / 2))));
      } else if (mode === 4) {
        // Random garbage bytes with bogus length header
        const garbage = Buffer.alloc(16);
        for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(rng() * 256);
        conn.end(garbage);
      } else if (mode === 5) {
        // Protocol mismatch
        conn.end(frame(JSON.stringify({ protocol: 99, id: msg.id, result: {} })));
      } else if (mode === 6) {
        // Both result and error (violates envelope invariant)
        conn.end(frame(JSON.stringify({ protocol: 1, id: msg.id, result: {}, error: { code: 'E', message: 'both' } })));
      } else {
        // Valid response chunked in 1-byte pieces
        const f = frame(JSON.stringify({ protocol: 1, id: msg.id, result: { chunked: true, idx } }));
        let off = 0;
        const pump = () => {
          if (off >= f.length) return conn.end();
          const step = 1 + Math.floor(rng() * 5);
          conn.write(f.subarray(off, off + step));
          off += step;
          setTimeout(pump, 1);
        };
        pump();
      }
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const bridge = new NativeBridge(socketPath, 2000);
  let okCount = 0;
  let errCount = 0;

  // Run 120 calls in parallel batches of 12
  for (let batch = 0; batch < 10; batch++) {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => bridge.call('browser.info', { batch, i }))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') okCount++;
      else errCount++;
    }
  }
  assert.ok(okCount >= 25, `Expected valid modes to succeed, got ${okCount}`);
  assert.ok(errCount >= 70, `Expected malformed modes to fail cleanly, got ${errCount}`);
});

test('fuzz: duration() and parseSha256Sums() handle 500 randomized inputs cleanly', () => {
  const rng = mulberry32(0x1337c0de);
  const alphabet = '0123456789msdh .-+eE_abcXYZ\t\n\0🚀';
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rng() * 14);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rng() * alphabet.length)];
    try {
      const ms = duration(s);
      assert.ok(Number.isSafeInteger(ms) && ms > 0, `Invalid positive ms from ${JSON.stringify(s)}: ${ms}`);
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  }

  // Known valid durations
  assert.equal(duration('1ms'), 1);
  assert.equal(duration('31d'), 31 * 86_400_000);
  assert.equal(duration('2h'), 7_200_000);

  // Checksum parser fuzz
  const sample = [
    '# comment',
    '',
    'A'.repeat(64) + '  dub-chromium-157.0.8082.0-linux-x64.tar.gz',
    'b'.repeat(64) + ' *dub-chromium-157.0.8082.0-darwin-arm64.tar.gz',
    'not-a-hash  evil.tar.gz',
    'c'.repeat(63) + '  short.tar.gz',
  ].join('\r\n');
  const map = parseSha256Sums(sample);
  assert.equal(map.size, 2);
  assert.equal(map.get('dub-chromium-157.0.8082.0-linux-x64.tar.gz'), 'a'.repeat(64));
  assert.equal(map.get('dub-chromium-157.0.8082.0-darwin-arm64.tar.gz'), 'b'.repeat(64));
});

test('fuzz: installBrowser verifies SHA-256, rejects tampering and path traversal, and caches cleanly', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-dl-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const bundleName = 'dub-chromium-157.0.8082.0-linux-x64';
  const tarballName = `${bundleName}.tar.gz`;

  // Create a valid fake bundle tarball
  const goodStage = join(work, 'good');
  await mkdir(join(goodStage, bundleName), { recursive: true });
  await writeFile(join(goodStage, bundleName, 'chrome'), '#!/bin/sh\necho dub\n', { mode: 0o755 });
  const goodTar = join(work, tarballName);
  assert.equal(spawnSync('tar', ['-czf', goodTar, '-C', goodStage, bundleName]).status, 0);
  const { readFile } = await import('node:fs/promises');
  const goodBytes = await readFile(goodTar);
  const goodSha = createHash('sha256').update(goodBytes).digest('hex');

  // Create a path-traversal tarball (-P preserves '../' in GNU/BSD tar)
  const evilTar = join(work, 'evil.tar.gz');
  const evilFile = join(work, 'pwn.txt');
  await writeFile(evilFile, 'evil');
  assert.equal(spawnSync('tar', ['-P', '-czf', evilTar, '-C', goodStage, '../pwn.txt']).status, 0);
  const evilBytes = await readFile(evilTar);
  const evilSha = createHash('sha256').update(evilBytes).digest('hex');

  let mode = 'good';
  const server = createHttpServer((req, res) => {
    if (req.url === '/SHA256SUMS.txt') {
      const sha = mode === 'evil' ? evilSha : goodSha;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`${sha}  ${tarballName}\n`);
      return;
    }
    if (req.url === `/${tarballName}`) {
      if (mode === 'tampered') {
        const bad = Buffer.from(goodBytes);
        bad[bad.length - 1] ^= 0xff;
        res.writeHead(200).end(bad);
        return;
      }
      res.writeHead(200).end(mode === 'evil' ? evilBytes : goodBytes);
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cacheDir = join(work, 'cache');

  // 1. Tampered tarball must be rejected by SHA-256 check
  mode = 'tampered';
  await assert.rejects(
    installBrowser({ baseUrl, cacheDir, platform: 'linux', arch: 'x64' }),
    /SHA-256 mismatch/
  );
  assert.equal(resolveInstalledBrowser(cacheDir, 'linux', 'x64'), undefined);

  // 2. Path-traversal tarball must be rejected before extraction
  mode = 'evil';
  await assert.rejects(
    installBrowser({ baseUrl, cacheDir, platform: 'linux', arch: 'x64' }),
    /unsafe tarball path/
  );

  // 3. Valid download succeeds and subsequent call hits cache
  mode = 'good';
  const res1 = await installBrowser({ baseUrl, cacheDir, platform: 'linux', arch: 'x64' });
  assert.equal(res1.cached, false);
  assert.equal(res1.sha256, goodSha);
  assert.equal(resolveInstalledBrowser(cacheDir, 'linux', 'x64'), res1.browserPath);

  const res2 = await installBrowser({ baseUrl, cacheDir, platform: 'linux', arch: 'x64' });
  assert.equal(res2.cached, true);
  assert.equal(res2.browserPath, res1.browserPath);
});

test('fuzz: HTTP MCP boundary rejects malformed origins, hosts, tokens & garbage payloads', async t => {
  const cli = createCommands(new Browser(new NativeBridge('/tmp/nonexistent-dub-fuzz.sock', 500)), {
    methods: ['browser.info'],
  });
  const token = 'secret-fuzz-token-0123456789-abcdef';
  const server = await listen(cli.fetch, { host: '127.0.0.1', port: 0, token });
  t.after(() => server.close());

  const badRequests = [
    // Missing token
    { headers: { 'content-type': 'application/json' }, body: '{}' },
    // Wrong token
    { headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' },
    // Foreign origin
    { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: '{}' },
    // Null origin
    { headers: { authorization: `Bearer ${token}`, origin: 'null' }, body: '{}' },
  ];

  for (const req of badRequests) {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
    });
    assert.ok(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  }
});

test('fuzz: TokenAuthority enforces atomic single-use, replay rejection, and untrusted scope attenuation across 200 trials', () => {
  const rng = mulberry32(0x51a7f00d);
  const authority = new TokenAuthority({ staticToken: 'dub-fuzz-master-token-0123456789' });
  const roles = ['maintainer', 'contributor', 'sandbox', 'agent', 'viewer'];
  const allScopes = ['mcp:read', 'mcp:write', 'mcp:admin', 'auth:mint', 'cache:read', 'cache:write', 'plugin:manage', 'profile:attach'];
  const privileged = new Set(['mcp:admin', 'auth:mint', 'cache:write', 'plugin:manage', 'profile:attach']);

  for (let i = 0; i < 200; i++) {
    const role = roles[Math.floor(rng() * roles.length)];
    const requestedScopes = allScopes.filter(() => rng() >= 0.5);
    const minted = authority.mintOneTimeToken({
      principal: `fuzz-${role}-${i}`,
      role,
      scopes: requestedScopes.length > 0 ? requestedScopes : undefined,
      ttlMs: 60_000,
    });

    if (minted.trust === 'untrusted') {
      for (const s of minted.scopes) {
        assert.equal(privileged.has(s), false, `Untrusted token leaked privileged scope ${s}`);
      }
    }

    // Mutate one byte of token -> must fail as invalid without consuming the real token
    const mutated = `${minted.oneTimeToken.slice(0, -1)}${minted.oneTimeToken.endsWith('A') ? 'B' : 'A'}`;
    assert.throws(() => authority.redeemOneTimeToken(mutated), err => err instanceof AuthError && err.code === 'OTT_INVALID');

    // First valid redemption succeeds
    const redeemed = authority.redeemOneTimeToken(minted.oneTimeToken);
    assert.ok(authority.verifyAuthorization(`Bearer ${redeemed.sessionToken}`));

    // Second redemption ALWAYS fails as replay
    assert.throws(
      () => authority.redeemOneTimeToken(minted.oneTimeToken),
      err => err instanceof AuthError && err.code === 'OTT_ALREADY_USED'
    );
  }

  // Garbage strings never redeem or crash
  for (const garbage of ['', 'dub_ott_', 'dub_ott_' + 'x'.repeat(10000), 'Bearer \0\r\n', 'not-a-token']) {
    assert.throws(() => authority.redeemOneTimeToken(garbage), err => err instanceof AuthError);
    assert.equal(authority.verifyAuthorization(garbage), null);
  }
});

test('fuzz: untrusted MCP JSON-RPC gate blocks every privileged tool across 120 randomized payloads', async t => {
  const rng = mulberry32(0xcafef00d);
  const authority = new TokenAuthority({ staticToken: 'dub-master-gate-fuzz-0123456789' });
  const cli = createCommands(new Browser(new NativeBridge('/tmp/nonexistent-dub-gate.sock', 200)), {
    methods: ['browser.info', 'profile.attach', 'plugin.load', 'browser.quit'],
  });
  const server = await listen(cli.fetch, { host: '127.0.0.1', port: 0, authority });
  t.after(() => server.close());

  const minted = authority.mintOneTimeToken({ principal: 'fork-pr-fuzz', role: 'contributor', ttlMs: 60_000 });
  const { sessionToken } = authority.redeemOneTimeToken(minted.oneTimeToken);
  const forbidden = ['profile_attach', 'plugin_load', 'plugin_unload', 'plugin_reload', 'quit'];

  for (let i = 0; i < 120; i++) {
    const tool = forbidden[Math.floor(rng() * forbidden.length)];
    const isBatch = rng() < 0.35;
    const call = { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: tool, arguments: { noise: rng() } } };
    const payload = isBatch
      ? [{ jsonrpc: '2.0', id: `safe-${i}`, method: 'tools/list', params: {} }, call]
      : call;
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 403, `Expected 403 for untrusted ${tool} (batch=${isBatch}), got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error?.code, -32003);
  }
});

test('fuzz: HTTP auth endpoints resist malformed JSON, invalid methods, and oversized payloads', async t => {
  const authority = new TokenAuthority({ staticToken: 'dub-http-edge-fuzz-0123456789' });
  const cli = createCommands(new Browser(new NativeBridge('/tmp/nonexistent-dub-edge.sock', 200)), {
    methods: ['browser.info'],
  });
  const server = await listen(cli.fetch, { host: '127.0.0.1', port: 0, authority });
  t.after(() => server.close());

  // Malformed JSON at /auth/exchange must return 400 (never 500)
  for (const raw of ['', '{', '[]', '"str"', 'null', '{"oneTimeToken":123}', '{"oneTimeToken":"dub_ott_invalid"}']) {
    const res = await fetch(`${server.url}/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    assert.ok(res.status === 400 || res.status === 401, `Unexpected status ${res.status} for payload ${raw}`);
  }

  // Wrong HTTP methods must return 405
  for (const [method, path] of [
    ['GET', '/auth/exchange'],
    ['DELETE', '/auth/whoami'],
    ['GET', '/auth/one-time-tokens'],
    ['GET', '/auth/revoke'],
  ]) {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: 'Bearer dub-http-edge-fuzz-0123456789' },
    });
    assert.equal(res.status, 405, `Expected 405 for ${method} ${path}, got ${res.status}`);
  }

  // Unauthenticated /auth/audit must return 401
  const auditUnauth = await fetch(`${server.url}/auth/audit`);
  assert.equal(auditUnauth.status, 401);

  // Oversized body (> 64 KiB on auth exchange) must fail cleanly without crashing the server
  const bigRes = await fetch(`${server.url}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oneTimeToken: 'x'.repeat(100_000) }),
  });
  assert.ok(bigRes.status === 400 || bigRes.status === 401 || bigRes.status === 413);

  // Server still responds cleanly to /health after abuse
  const health = await fetch(`${server.url}/health`, {
    headers: { authorization: 'Bearer dub-http-edge-fuzz-0123456789' },
  });
  assert.equal(health.status, 200);
});

test('fuzz: Smithers Home.read() handles 100 malformed, oversized, and injection schemas cleanly', async () => {
  const { Home } = await import('@smthrs/views');
  const rng = mulberry32(0x1337beef);
  const badInputs = [
    '',
    'not json',
    '{}',
    '[]',
    'null',
    JSON.stringify({ docs: 'javascript:alert(1)', sections: [] }),
    JSON.stringify({ sections: [{ audience: 'superadmin', blocks: [] }] }),
    JSON.stringify({ sections: [{ audience: 'everyone', blocks: [{ type: 'raw_html', html: '<script>alert(1)</script>' }] }] }),
  ];

  for (const input of badInputs) {
    const res = Home.read(input);
    assert.ok(res && typeof res._tag === 'string');
    if (res._tag === 'Declared') {
      assert.equal(JSON.stringify(res).includes('<script>'), false);
    }
  }

  const blockTypes = ['hero', 'code', 'cards', 'links', 'stats', 'unknown', 'script', 42, null];
  const audiences = ['everyone', 'contributor', 'maintainer', 'root', '', null];
  for (let i = 0; i < 100; i++) {
    const candidate = {
      docs: rng() < 0.5 ? 'https://dangerouslyusebrowser.smithers.sh/llms.txt' : 'ftp://bad.example/file',
      contributors: rng() < 0.5 ? 'role' : 'invalid',
      sections: [
        {
          title: rng() < 0.5 ? `Sec ${i}` : undefined,
          audience: audiences[Math.floor(rng() * audiences.length)],
          blocks: Array.from({ length: Math.floor(rng() * 4) }, () => ({
            type: blockTypes[Math.floor(rng() * blockTypes.length)],
            title: `T${i}`,
            text: `Body ${i}`,
          })),
        },
      ],
    };
    const parsed = Home.read(JSON.stringify(candidate));
    assert.ok(parsed && typeof parsed._tag === 'string');
  }
});

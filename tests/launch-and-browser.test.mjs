import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachProfile, launch } from '../dist/launch.js';
import { Browser } from '../dist/browser.js';
import { NativeBridge } from '../dist/native.js';

function startFakeDubSocket(socketPath, profilePath, instanceId = 'dub-fake-1') {
  const server = createServer(conn => {
    let buf = Buffer.alloc(0);
    conn.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        const reply = {
          protocol: 1,
          id: msg.id,
          ok: true,
          result:
            msg.method === 'browser.info'
              ? {
                  product: 'Dub',
                  protocol: 1,
                  chromium: '157.0.8082.0',
                  revision: '0e331aaf43bf',
                  profile: profilePath,
                  instanceId,
                  methods: ['browser.info', 'tabs.list', 'net.log'],
                }
              : msg.method === 'tabs.list'
                ? { tabs: [{ id: 1, url: 'https://example.com', title: 'Example', active: true, loading: false }] }
                : { echoed: msg.method, params: msg.params ?? {} },
        };
        const body = Buffer.from(JSON.stringify(reply), 'utf8');
        const frame = Buffer.allocUnsafe(4 + body.length);
        frame.writeUInt32BE(body.length, 0);
        body.copy(frame, 4);
        conn.write(frame);
      }
    });
  });
  return server;
}

test('attachProfile reports not_running when socket and SingletonLock are absent', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-attach-empty-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const res = await attachProfile({
    name: 'Default',
    dir: work,
    socket: join(work, 'missing.sock'),
  });
  assert.equal(res.status, 'not_running');
  assert.equal(res.owned, false);
  assert.equal(res.requiresRestart, true);
  assert.match(res.message, /dub serve/);
});

test('attachProfile reports locked_by_other_process when Chromium SingletonLock exists', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-attach-lock-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, 'SingletonLock'), '12345');
  const res = await attachProfile({
    name: 'Work',
    dir: work,
    socket: join(work, 'missing.sock'),
  });
  assert.equal(res.status, 'locked_by_other_process');
  assert.equal(res.requiresRestart, true);
  assert.match(res.message, /locked by another Chromium process/);
});

test('attachProfile reconnects to matching running Dub socket and flags mismatched profile', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-attach-live-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const socketPath = join(work, 'dub.sock');
  const activeProfile = join(work, 'Default');
  const server = startFakeDubSocket(socketPath, activeProfile, 'dub-inst-42');
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const matched = await attachProfile({ name: 'Default', dir: work, socket: socketPath });
  assert.equal(matched.status, 'reconnected');
  assert.equal(matched.requiresRestart, false);
  assert.equal(matched.instanceId, 'dub-inst-42');

  const mismatched = await attachProfile({ name: 'Profile 2', dir: work, socket: socketPath });
  assert.equal(mismatched.status, 'requires_restart');
  assert.equal(mismatched.requiresRestart, true);
  assert.equal(mismatched.currentProfile, activeProfile);
});

test('launch({ connect: true }) attaches cleanly to an existing Dub socket without spawning', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-connect-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const socketPath = join(work, 'dub.sock');
  const server = startFakeDubSocket(socketPath, join(work, 'Default'), 'dub-inst-connect');
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const session = await launch({ connect: true, socket: socketPath });
  assert.equal(session.owned, false);
  assert.equal(session.info.instanceId, 'dub-inst-connect');
  assert.deepEqual(session.health(), { ok: true, state: 'ready', owned: false });

  const tabs = await session.browser.tabs();
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].url, 'https://example.com');

  await session.close();
  assert.deepEqual(session.health(), { ok: false, state: 'stopped', owned: false });
});

test('launch rejects overly long socket paths and non-socket collisions before spawning Chromium', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-bad-sock-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fakeChrome = join(work, 'fake-chrome');
  await writeFile(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  await assert.rejects(
    launch({ browser: fakeChrome, socket: join(work, 'a'.repeat(140) + '.sock') }),
    /Socket path is too long/
  );

  const regularFile = join(work, 'not-a-socket.sock');
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(regularFile, 'plain file');
  await assert.rejects(
    launch({ browser: fakeChrome, socket: regularFile }),
    /Refusing to replace a non-socket/
  );
});

test('Browser validates protocol version and dub identity handshake', async t => {
  const work = await mkdtemp(join(tmpdir(), 'dub-bad-info-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const socketPath = join(work, 'bad.sock');
  const server = createServer(conn => {
    conn.once('data', chunk => {
      const len = chunk.readUInt32BE(0);
      const msg = JSON.parse(chunk.subarray(4, 4 + len).toString('utf8'));
      const reply = { id: msg.id, ok: true, result: { dub: false, protocolVersion: 99 } };
      const body = Buffer.from(JSON.stringify(reply), 'utf8');
      const frame = Buffer.allocUnsafe(4 + body.length);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      conn.write(frame);
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const browser = new Browser(new NativeBridge(socketPath, 1000));
  await assert.rejects(() => browser.info(), /Not a Dub browser|protocol/i);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
const { request } = createRequire(import.meta.url)('../build/Release/dub.node');

// Protocol fixtures exercise the real compiled N-API/C ABI, not Chromium.
export async function fixture(t, handle) {
  const dir = await mkdtemp(join(tmpdir(), 'dub-'));
  const path = join(dir, 's');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    handle(socket);
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return path;
}
export function frame(text) {
  const body = Buffer.from(text);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
test('compiled N-API sends framed UTF-8 and receives fragmented responses without blocking Node', async t => {
  const body = JSON.stringify({ message: 'hello 🌍', body: 'x'.repeat(512 * 1024) });
  let received;
  const path = await fixture(t, socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (pending.length >= 4 && pending.length === pending.readUInt32BE(0) + 4) {
        received = pending.subarray(4).toString();
        const encoded = frame(body);
        socket.write(encoded.subarray(0, 2));
        setTimeout(() => socket.end(encoded.subarray(2)), 35);
      }
    });
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { assert.equal(await request(path, body, 2000), body); }
  finally { clearInterval(timer); }
  assert.equal(received, body);
  assert.ok(ticks > 2, 'native IO must not block the event loop');
});
test('native calls are independent and safe in parallel', async t => {
  const path = await fixture(t, socket => socket.on('data', data => socket.end(data)));
  const result = await Promise.all(Array.from({ length: 20 }, (_, i) => request(path, String(i), 2000)));
  assert.deepEqual(result, Array.from({ length: 20 }, (_, i) => String(i)));
});
test('a whole-call deadline applies to a stalled browser', async t => {
  const path = await fixture(t, () => {});
  const start = performance.now();
  await assert.rejects(request(path, '{}', 50), /timed out/);
  assert.ok(performance.now() - start < 1500);
});
test('a slow trickle cannot reset the deadline', async t => {
  const path = await fixture(t, socket => {
    const bytes = frame('x'.repeat(50)); let i = 0;
    const timer = setInterval(() => { if (i < bytes.length) socket.write(bytes.subarray(i, ++i)); }, 10);
    socket.on('close', () => clearInterval(timer));
  });
  await assert.rejects(request(path, '{}', 80), /timed out/);
});
test('truncated and oversized responses fail without crashing the host', async t => {
  const short = await fixture(t, s => s.end(Buffer.from([0, 0, 0, 20, 123])));
  await assert.rejects(request(short, '{}', 1000), /closed/);
  const huge = await fixture(t, s => s.end(Buffer.from([127, 255, 255, 255])));
  await assert.rejects(request(huge, '{}', 1000), /length/);
  const empty = await fixture(t, s => s.end(Buffer.alloc(4)));
  await assert.rejects(request(empty, '{}', 1000), /length/);
});
test('invalid native inputs are rejected before IO', async () => {
  assert.throws(() => request({}, '{}'), /requires strings/);
  assert.throws(() => request('/a\0b', '{}'), /requires strings/);
  for (const timeout of [0, -1, 0.5, NaN, Infinity, 300001, '10']) assert.throws(() => request('/x', '{}', timeout), /timeoutMs/);
  await assert.rejects(request('/' + 'x'.repeat(120), '{}'), /socket path/);
  await assert.rejects(request('/x', ''), /1 byte/);
  await assert.rejects(request('/definitely-not-a-dub-socket', '{}'), /Cannot connect/);
});

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, lstat, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser } from './browser.js';
import { defaultSocket, NativeBridge } from './native.js';

export type LaunchOptions = { browser?: string; socket?: string; profile?: string; profileName?: string; headless?: boolean; connect?: boolean };
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  await finished;
  clearTimeout(timer);
}
export async function launch(options: LaunchOptions = {}) {
  const socket = resolve(options.socket ?? defaultSocket());
  const browser = new Browser(new NativeBridge(socket));
  if (options.connect) { await browser.info(); return { browser, close: async () => {} }; }
  const executable = options.browser ?? process.env.DUB_BROWSER;
  if (!executable) throw new Error('Set DUB_BROWSER or --browser to a compiled Dub Chromium executable. See docs/build.md.');
  const executablePath = await realpath(executable);
  if (Buffer.byteLength(socket) > (process.platform === 'darwin' ? 103 : 107)) throw new Error('Socket path is too long; set DUB_SOCKET to a shorter path');
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new Error('Dub socket directory must be owned by you with mode 0700');
  const existing = await lstat(socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Refusing to replace a non-socket or another user’s socket');
    let live = false;
    try { await new Browser(new NativeBridge(socket, 1000)).info(); live = true; } catch {}
    if (live) throw new Error('Dub is already running on this socket; connect to that server or choose another DUB_SOCKET');
    // A failed handshake does not prove a listener is absent. Connect without sending first.
    const { createConnection } = await import('node:net');
    const absent = await new Promise<boolean>(resolve => {
      const probe = createConnection(socket);
      probe.setTimeout(1000);
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('timeout', () => { probe.destroy(); resolve(false); });
      probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'));
    });
    if (!absent) throw new Error('Socket has a live listener that did not identify as Dub');
    await unlink(socket).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  }
  const profile = resolve(options.profile ?? join(homedir(), '.dub', 'profile'));
  const args = [`--dub-socket=${socket}`, `--user-data-dir=${profile}`, `--profile-directory=${options.profileName ?? 'Default'}`, '--no-first-run', '--no-default-browser-check', '--enable-experimental-web-platform-features'];
  if (options.headless) args.push('--headless=new');
  args.push('about:blank');
  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  child.stderr?.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8000); });
  const deadline = Date.now() + 30000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dub browser exited during startup (${child.exitCode ?? child.signalCode}). ${diagnostic}`);
      try {
        await new Browser(new NativeBridge(socket, 500)).info();
        return { browser, close: async () => { await stop(child); await unlink(socket).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); } };
      } catch { await delay(100); }
    }
    throw new Error(`Browser did not identify as a Dub fork within 30 seconds. Stock Chromium is unsupported. ${diagnostic}`);
  } catch (error) {
    if (!spawnError) await stop(child);
    throw error;
  }
}

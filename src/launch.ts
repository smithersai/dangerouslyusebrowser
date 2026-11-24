import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, lstat, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser, type BrowserInfo } from './browser.js';
import { defaultSocket, NativeBridge } from './native.js';

export type SessionState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type SessionHealth = {
  ok: boolean;
  state: SessionState;
  owned: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
};
export type LaunchOptions = { browser?: string; socket?: string; profile?: string; profileName?: string; headless?: boolean; connect?: boolean };
export type Session = {
  browser: Browser;
  info: BrowserInfo;
  owned: boolean;
  health: () => SessionHealth;
  close: () => Promise<void>;
};

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  await finished;
  clearTimeout(timer);
}

async function unlinkIfSameSocket(socket: string, expected: { dev: number; ino: number } | undefined) {
  if (!expected) return;
  const current = await lstat(socket).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
  if (!current || !current.isSocket()) return;
  if (current.dev !== expected.dev || current.ino !== expected.ino) return;
  await unlink(socket).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}

export async function launch(options: LaunchOptions = {}): Promise<Session> {
  const socket = resolve(options.socket ?? defaultSocket());
  const browser = new Browser(new NativeBridge(socket));
  if (options.connect) {
    const info = await browser.info();
    let state: SessionState = 'ready';
    return {
      browser,
      info,
      owned: false,
      health: () => ({ ok: state === 'ready', state, owned: false }),
      close: async () => { state = 'stopped'; },
    };
  }
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
    const { createConnection } = await import('node:net');
    const absent = await new Promise<boolean>(resolve => {
      const probe = createConnection(socket);
      probe.setTimeout(1000);
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('timeout', () => { probe.destroy(); resolve(false); });
      probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'));
    });
    if (!absent) throw new Error('Socket has a live listener that did not identify as Dub');
    await unlinkIfSameSocket(socket, { dev: existing.dev, ino: existing.ino });
  }
  const profile = resolve(options.profile ?? join(homedir(), '.dub', 'profile'));
  const args = [`--dub-socket=${socket}`, `--user-data-dir=${profile}`, `--profile-directory=${options.profileName ?? 'Default'}`, '--no-first-run', '--no-default-browser-check', '--enable-experimental-web-platform-features'];
  if (options.headless) args.push('--headless=new');
  args.push('about:blank');
  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; let spawnError: Error | undefined;
  let state: SessionState = 'starting';
  let exitCode: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  let ownedSocketId: { dev: number; ino: number } | undefined;

  child.on('error', error => { spawnError = error; if (state !== 'stopping' && state !== 'stopped') state = 'failed'; });
  child.stderr?.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8000); });
  child.once('exit', (code, sig) => {
    exitCode = code;
    signal = sig;
    if (state === 'ready' || state === 'starting') state = 'failed';
  });

  const deadline = Date.now() + 30000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dub browser exited during startup (${child.exitCode ?? child.signalCode}). ${diagnostic}`);
      try {
        const info = await new Browser(new NativeBridge(socket, 500)).info();
        const st = await lstat(socket).catch(() => undefined);
        if (st?.isSocket()) ownedSocketId = { dev: st.dev, ino: st.ino };
        state = 'ready';
        let closing: Promise<void> | undefined;
        return {
          browser,
          info,
          owned: true,
          health: () => ({
            ok: state === 'ready' && child.exitCode === null && child.signalCode === null,
            state,
            owned: true,
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(signal !== undefined ? { signal } : {}),
            ...(state === 'failed' && diagnostic ? { error: diagnostic.slice(-500) } : {}),
          }),
          close: () => {
            if (closing) return closing;
            state = 'stopping';
            closing = (async () => {
              try { await stop(child); }
              finally {
                await unlinkIfSameSocket(socket, ownedSocketId);
                state = 'stopped';
              }
            })();
            return closing;
          },
        };
      } catch { await delay(100); }
    }
    throw new Error(`Browser did not identify as a Dub fork within 30 seconds. Stock Chromium is unsupported. ${diagnostic}`);
  } catch (error) {
    state = 'failed';
    if (!spawnError) await stop(child);
    const st = await lstat(socket).catch(() => undefined);
    if (st?.isSocket() && ownedSocketId) await unlinkIfSameSocket(socket, ownedSocketId);
    throw error;
  }
}

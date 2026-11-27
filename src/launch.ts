import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, lstat, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser, type BrowserInfo } from './browser.js';
import { resolveInstalledBrowser } from './download.js';
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
  // Chromium treats SIGINT as a graceful exit (flushing cookies & storage),
  // whereas SIGTERM triggers SessionEnding fast-exit on Linux.
  child.kill('SIGINT');
  const termTimer = setTimeout(() => child.kill('SIGTERM'), 4000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 7000);
  termTimer.unref();
  killTimer.unref();
  await finished;
  clearTimeout(termTimer);
  clearTimeout(killTimer);
}

async function unlinkIfSameSocket(socket: string, expected: { dev: number; ino: number } | undefined) {
  if (!expected) return;
  const current = await lstat(socket).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
  if (!current || !current.isSocket()) return;
  if (current.dev !== expected.dev || current.ino !== expected.ino) return;
  await unlink(socket).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}

async function prepareSocketPath(socket: string): Promise<void> {
  if (Buffer.byteLength(socket) > (process.platform === 'darwin' ? 103 : 107)) {
    throw new Error('Socket path is too long; set DUB_SOCKET to a shorter path');
  }
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) {
    throw new Error('Dub socket directory must be owned by you with mode 0700');
  }
  const existing = await lstat(socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
    throw new Error('Refusing to replace a non-socket or another user’s socket');
  }
  let live = false;
  try { await new Browser(new NativeBridge(socket, 1000)).info(); live = true; } catch {}
  if (live) throw new Error('Dub is already running on this socket; connect to that server or choose another DUB_SOCKET');
  const { createConnection } = await import('node:net');
  const absent = await new Promise<boolean>(resolveProbe => {
    const probe = createConnection(socket);
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolveProbe(false); });
    probe.once('timeout', () => { probe.destroy(); resolveProbe(false); });
    probe.once('error', (e: NodeJS.ErrnoException) => resolveProbe(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'));
  });
  if (!absent) throw new Error('Socket has a live listener that did not identify as Dub');
  await unlinkIfSameSocket(socket, { dev: existing.dev, ino: existing.ino });
}

function createOwnedSession(
  child: ChildProcess,
  browser: Browser,
  info: BrowserInfo,
  socket: string,
  ownedSocketId: { dev: number; ino: number } | undefined,
  tracker: { state: SessionState; exitCode?: number | null; signal?: NodeJS.Signals | null; diagnostic: string },
): Session {
  let closing: Promise<void> | undefined;
  return {
    browser,
    info,
    owned: true,
    health: () => ({
      ok: tracker.state === 'ready' && child.exitCode === null && child.signalCode === null,
      state: tracker.state,
      owned: true,
      ...(tracker.exitCode !== undefined ? { exitCode: tracker.exitCode } : {}),
      ...(tracker.signal !== undefined ? { signal: tracker.signal } : {}),
      ...(tracker.state === 'failed' && tracker.diagnostic ? { error: tracker.diagnostic.slice(-500) } : {}),
    }),
    close: () => {
      if (closing) return closing;
      tracker.state = 'stopping';
      closing = (async () => {
        try { await stop(child); }
        finally {
          await unlinkIfSameSocket(socket, ownedSocketId);
          tracker.state = 'stopped';
        }
      })();
      return closing;
    },
  };
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
  const executable = options.browser ?? process.env.DUB_BROWSER ?? resolveInstalledBrowser();
  if (!executable) throw new Error('Dub Chromium binary not found. Run "dub install" or set DUB_BROWSER=/path/to/chrome.');
  const executablePath = await realpath(executable);
  await prepareSocketPath(socket);

  const profile = resolve(options.profile ?? join(homedir(), '.dub', 'profile'));
  const args = [
    `--dub-socket=${socket}`,
    `--user-data-dir=${profile}`,
    `--profile-directory=${options.profileName ?? 'Default'}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-experimental-web-platform-features',
  ];
  if (options.headless) args.push('--headless=new');
  args.push('about:blank');

  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError: Error | undefined;
  let ownedSocketId: { dev: number; ino: number } | undefined;
  const tracker: { state: SessionState; exitCode?: number | null; signal?: NodeJS.Signals | null; diagnostic: string } = {
    state: 'starting',
    diagnostic: '',
  };

  child.on('error', error => {
    spawnError = error;
    if (tracker.state !== 'stopping' && tracker.state !== 'stopped') tracker.state = 'failed';
  });
  child.stderr?.on('data', data => { tracker.diagnostic = (tracker.diagnostic + data.toString()).slice(-8000); });
  child.once('exit', (code, sig) => {
    tracker.exitCode = code;
    tracker.signal = sig;
    if (tracker.state === 'ready' || tracker.state === 'starting') tracker.state = 'failed';
  });

  const deadline = Date.now() + 30000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Dub browser exited during startup (${child.exitCode ?? child.signalCode}). ${tracker.diagnostic}`);
      }
      try {
        const info = await new Browser(new NativeBridge(socket, 500)).info();
        const st = await lstat(socket).catch(() => undefined);
        if (st?.isSocket()) ownedSocketId = { dev: st.dev, ino: st.ino };
        tracker.state = 'ready';
        return createOwnedSession(child, browser, info, socket, ownedSocketId, tracker);
      } catch { await delay(100); }
    }
    throw new Error(`Browser did not identify as a Dub fork within 30 seconds. Stock Chromium is unsupported. ${tracker.diagnostic}`);
  } catch (error) {
    tracker.state = 'failed';
    if (!spawnError) await stop(child);
    const st = await lstat(socket).catch(() => undefined);
    if (st?.isSocket() && ownedSocketId) await unlinkIfSameSocket(socket, ownedSocketId);
    throw error;
  }
}

export type ProfileAttachResult = {
  status: 'reconnected' | 'requires_restart' | 'locked_by_other_process' | 'not_running';
  owned: false;
  requiresRestart: boolean;
  socket: string;
  profile: string;
  currentProfile?: string;
  instanceId?: string;
  message: string;
};

export async function attachProfile(options: {
  name: string;
  dir?: string;
  socket?: string;
}): Promise<ProfileAttachResult> {
  const socket = resolve(options.socket ?? defaultSocket());
  const userDataDir = resolve(options.dir ?? join(homedir(), '.dub', 'profile'));
  const targetProfile = join(userDataDir, options.name);

  try {
    const info = await new Browser(new NativeBridge(socket, 1000)).info();
    const matchesPath =
      info.profile === targetProfile ||
      (dirname(info.profile) === userDataDir && basename(info.profile) === options.name);
    if (matchesPath) {
      return {
        status: 'reconnected',
        owned: false,
        requiresRestart: false,
        socket,
        profile: info.profile,
        instanceId: info.instanceId,
        message: `Reconnected to running Dub session for profile ${options.name}.`,
      };
    }
    return {
      status: 'requires_restart',
      owned: false,
      requiresRestart: true,
      socket,
      profile: targetProfile,
      currentProfile: info.profile,
      instanceId: info.instanceId,
      message:
        `Dub is currently running with profile ${info.profile}. Stop that session or launch a separate Dub instance with --socket, --profile ${userDataDir}, and --profile-name ${options.name}.`,
    };
  } catch {
    // No live Dub listener on this socket; check whether Chromium's SingletonLock
    // indicates another browser process (such as stock Chrome) owns the directory.
    const lockStat = await lstat(join(userDataDir, 'SingletonLock')).catch(() => undefined);
    if (lockStat) {
      return {
        status: 'locked_by_other_process',
        owned: false,
        requiresRestart: true,
        socket,
        profile: targetProfile,
        message:
          `Profile directory ${userDataDir} is locked by another Chromium process. Dub does not attach to arbitrary stock Chrome; close that browser or select a separate profile directory.`,
      };
    }
    return {
      status: 'not_running',
      owned: false,
      requiresRestart: true,
      socket,
      profile: targetProfile,
      message:
        `No Dub browser is listening on ${socket}. Start one with: dub serve --profile ${userDataDir} --profile-name ${options.name} --socket ${socket}`,
    };
  }
}

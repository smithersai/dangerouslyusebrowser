import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

export const CHROMIUM_VERSION = '157.0.8082.0';
export const DEFAULT_RELEASE_TAG = 'v0.1.0-alpha.1';
export const DEFAULT_REPO = 'smithersai/dangerouslyusebrowser';

export type InstallOptions = {
  release?: string;
  baseUrl?: string;
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  force?: boolean;
};

export type InstallResult = {
  browserPath: string;
  bundleDir: string;
  tarballName: string;
  sha256: string;
  cached: boolean;
};

export function defaultCacheDir(): string {
  return resolve(process.env.DUB_CACHE_DIR || join(homedir(), '.cache', 'dub'));
}

export function bundleNameFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const normalizedArch = arch === 'x64' ? 'x64' : arch;
  return `dub-chromium-${CHROMIUM_VERSION}-${platform}-${normalizedArch}`;
}

export function browserBinaryIn(bundleDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    const appBin = join(bundleDir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (existsSync(appBin)) return appBin;
  }
  return join(bundleDir, 'chrome');
}

export function resolveInstalledBrowser(
  cacheDir = defaultCacheDir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  const dir = join(cacheDir, bundleNameFor(platform, arch));
  const bin = browserBinaryIn(dir, platform);
  return existsSync(bin) ? bin : undefined;
}

export function parseSha256Sums(content: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[1] && match[2]) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

async function fetchToFileWithSha256(url: string, destPath: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const hash = createHash('sha256');
  const fileStream = createWriteStream(destPath);
  const readable = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  readable.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(readable, fileStream);
  return hash.digest('hex');
}

export async function installBrowser(options: InstallOptions = {}): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!['linux', 'darwin'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}-${arch}. Dub supports linux-x64 and darwin-arm64.`);
  }
  const cacheDir = resolve(options.cacheDir ?? defaultCacheDir());
  const bundleName = bundleNameFor(platform, arch);
  const tarballName = `${bundleName}.tar.gz`;
  const bundleDir = join(cacheDir, bundleName);
  const existing = browserBinaryIn(bundleDir, platform);

  if (!options.force && existsSync(existing)) {
    return { browserPath: existing, bundleDir, tarballName, sha256: 'cached', cached: true };
  }

  const release = options.release ?? process.env.DUB_RELEASE_TAG ?? DEFAULT_RELEASE_TAG;
  const baseUrl = (
    options.baseUrl ??
    process.env.DUB_RELEASE_BASE_URL ??
    `https://github.com/${DEFAULT_REPO}/releases/download/${release}`
  ).replace(/\/+$/, '');

  const sumsRes = await fetch(`${baseUrl}/SHA256SUMS.txt`, { redirect: 'follow' });
  if (!sumsRes.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/SHA256SUMS.txt: HTTP ${sumsRes.status} ${sumsRes.statusText}`);
  }
  const sums = parseSha256Sums(await sumsRes.text());
  const expectedSha = sums.get(tarballName);
  if (!expectedSha) {
    throw new Error(
      `No checksum entry for ${tarballName} in ${baseUrl}/SHA256SUMS.txt. Available: ${[...sums.keys()].join(', ') || 'none'}`
    );
  }

  await mkdir(cacheDir, { recursive: true });
  const stageDir = await mkdtemp(join(tmpdir(), 'dub-download-'));
  try {
    const tarballPath = join(stageDir, tarballName);
    const actualSha = await fetchToFileWithSha256(`${baseUrl}/${tarballName}`, tarballPath);
    if (actualSha !== expectedSha) {
      throw new Error(`SHA-256 mismatch for ${tarballName}: expected ${expectedSha}, got ${actualSha}`);
    }

    // Verify tarball does not contain path traversal entries before extracting
    const listRes = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
    if (listRes.status !== 0) throw new Error(`Failed to inspect ${tarballName}: ${listRes.stderr}`);
    for (const entry of listRes.stdout.split(/\r?\n/)) {
      if (!entry) continue;
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`Refusing to extract unsafe tarball path: ${entry}`);
      }
    }

    const extractRoot = join(stageDir, 'extracted');
    await mkdir(extractRoot, { recursive: true });
    const extractRes = spawnSync('tar', ['-xzf', tarballPath, '-C', extractRoot], { encoding: 'utf8' });
    if (extractRes.status !== 0) throw new Error(`Failed to extract ${tarballName}: ${extractRes.stderr}`);

    const extractedBundle = join(extractRoot, bundleName);
    if (!existsSync(browserBinaryIn(extractedBundle, platform))) {
      throw new Error(`Extracted archive did not contain expected Dub binary under ${bundleName}/`);
    }

    await rm(bundleDir, { recursive: true, force: true });
    await rename(extractedBundle, bundleDir);
    const browserPath = browserBinaryIn(bundleDir, platform);
    return { browserPath, bundleDir, tarballName, sha256: actualSha, cached: false };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

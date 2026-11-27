import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, ROOT, walkFiles } from './_lib.ts';

// 1. C++ addon must never abort() or exit() the host Node process
const nativeFiles = walkFiles(join(ROOT, 'native'), ['.cc', '.h', '.cpp']);
let abortHit: string | undefined;
for (const file of nativeFiles) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, '');
    if (/\b(?:std::)?(?:abort|exit|_exit|terminate)\s*\(/.test(code)) {
      abortHit = `${file}:${i + 1}: forbidden process termination call`;
      break;
    }
  }
  if (abortHit) break;
}
emit('cpp-no-abort', abortHit ? 'fail' : 'pass', { item: 'native', note: abortHit });

// 2. Strict C++20 compiler flags in scripts/build-native.mjs
const buildScript = readFileSync(join(ROOT, 'scripts/build-native.mjs'), 'utf8');
const requiredFlags = ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8'];
const missingFlags = requiredFlags.filter(flag => !buildScript.includes(flag));
emit('cpp-strict-flags', missingFlags.length === 0 ? 'pass' : 'fail', {
  item: 'build-native.mjs',
  note: missingFlags.length > 0 ? `Missing flags: ${missingFlags.join(', ')}` : undefined,
});

// 3. Chromium 157 overlay & patch integrity
const overlayRes = spawnSync(process.execPath, ['scripts/verify-overlay.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
});
emit('overlay-integrity', overlayRes.status === 0 ? 'pass' : 'fail', {
  item: 'chromium-157',
  note: overlayRes.status === 0 ? undefined : (overlayRes.stderr || overlayRes.stdout).trim().slice(0, 140),
});

// 4. Public repo hygiene: no private infrastructure leaks
const privatePatterns: Array<[string, RegExp]> = [
  ['private-host', /\bnyc-0[12]\b/i],
  ['private-provider', /\b(?:hetzner|latitude\.sh|tailscale)\b/i],
  ['internal-codename', /\bjjhub\b/i],
  ['local-home-path', /\/Users\/williamcory\b/],
];
const scanRoots = ['src', 'native', 'docs', 'site', 'scripts', '.smithers/wiki', '.github'];
let leakHit: string | undefined;
const allowedDocs = new Set(['docs/decisions.md']);
for (const rootDir of scanRoots) {
  const fullRoot = join(ROOT, rootDir);
  if (!existsSync(fullRoot)) continue;
  for (const file of walkFiles(fullRoot, ['.ts', '.js', '.mjs', '.md', '.html', '.css', '.json', '.yml', '.yaml', '.cc', '.h'])) {
    if (allowedDocs.has(file) || file.endsWith('verify-overlay.mjs')) continue;
    const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [label, pat] of privatePatterns) {
        if (pat.test(lines[i]!)) {
          leakHit = `${file}:${i + 1} (${label})`;
          break;
        }
      }
      if (leakHit) break;
    }
    if (leakHit) break;
  }
  if (leakHit) break;
}
emit('no-private-leaks', leakHit ? 'fail' : 'pass', { item: 'public-tree', note: leakHit });

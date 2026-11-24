#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REVISION_PATH = join(REPO_ROOT, 'chromium', 'revision.json');
const OVERLAY_DIR = join(REPO_ROOT, 'chromium', 'overlay');
const PATCHES_DIR = join(REPO_ROOT, 'chromium', 'patches');
const MANIFEST_FILENAME = '.dub-overlay-manifest.json';

function readRevision() {
  return JSON.parse(readFileSync(REVISION_PATH, 'utf8'));
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...opts,
  });
  if (result.error) throw result.error;
  if (!opts.allowFail && result.status !== 0) {
    const detail = opts.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}${detail}`);
  }
  return result;
}

function git(srcDir, args, opts = {}) {
  return run('git', ['-C', srcDir, ...args], { capture: true, ...opts });
}

function walkFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, base));
    else if (entry.isFile()) files.push(relative(base, full));
  }
  return files;
}

function listPatches() {
  if (!existsSync(PATCHES_DIR)) return [];
  return readdirSync(PATCHES_DIR)
    .filter(name => name.endsWith('.patch'))
    .sort((a, b) => a.localeCompare(b));
}

function dubCommit() {
  const jj = spawnSync('jj', ['-R', REPO_ROOT, '--no-pager', 'log', '-r', '@', '--no-graph', '-T', 'commit_id'], {
    encoding: 'utf8',
  });
  if (jj.status === 0 && jj.stdout.trim()) return jj.stdout.trim().slice(0, 12);
  const g = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' });
  if (g.status === 0 && g.stdout.trim()) return g.stdout.trim();
  return 'unknown';
}

function parseArgs(argv) {
  const action = argv[0];
  const opts = {
    src: process.env.DUB_CHROMIUM_SRC || join(homedir(), 'chromium', 'src'),
    out: process.env.DUB_CHROMIUM_OUT || 'out/Default',
    target: 'chrome',
    profile: 'dev',
    sccache: 'auto',
    noApply: false,
    jobs: undefined,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--src') opts.src = resolve(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--sccache') opts.sccache = argv[++i];
    else if (arg === '--jobs' || arg === '-j') opts.jobs = argv[++i];
    else if (arg === '--no-apply') opts.noApply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { action, opts };
}

function verifyPinnedHead(srcDir, rev) {
  if (!existsSync(join(srcDir, '.git'))) {
    throw new Error(`Chromium source not found at ${srcDir}. Run "node scripts/chromium.mjs fetch --src ${srcDir}" first.`);
  }
  const head = git(srcDir, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== rev.revision) {
    throw new Error(`Chromium HEAD mismatch at ${srcDir}: expected ${rev.revision}, got ${head}. Refusing to apply approximate hunks.`);
  }
  return head;
}

function parseDirtyPaths(srcDir) {
  const status = git(srcDir, ['status', '--porcelain', '--untracked-files=all']).stdout;
  const dirty = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const path = line.slice(3).trim();
    if (path === MANIFEST_FILENAME || path === 'out' || path.startsWith('out/')) continue;
    dirty.push({ code: line.slice(0, 2), path });
  }
  return dirty;
}

function revertExistingOverlay(srcDir) {
  const manifestPath = join(srcDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    const dirty = parseDirtyPaths(srcDir);
    if (dirty.length > 0) {
      throw new Error(
        `Upstream Chromium tree at ${srcDir} has unrelated dirty files (no ${MANIFEST_FILENAME}):\n` +
          dirty.slice(0, 20).map(d => `  ${d.code} ${d.path}`).join('\n')
      );
    }
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const knownOverlay = new Set(manifest.overlayFiles || []);
  const knownPatched = new Set(manifest.patchedFiles || []);
  const dirty = parseDirtyPaths(srcDir);
  const unknown = dirty.filter(d => !knownOverlay.has(d.path) && !knownPatched.has(d.path));
  if (unknown.length > 0) {
    throw new Error(
      `Refusing to overwrite unrelated dirty files in ${srcDir}:\n` +
        unknown.slice(0, 20).map(d => `  ${d.code} ${d.path}`).join('\n')
    );
  }
  if (knownPatched.size > 0) {
    git(srcDir, ['checkout', '--', ...knownPatched]);
  }
  for (const rel of knownOverlay) {
    const target = join(srcDir, rel);
    if (existsSync(target)) rmSync(target, { force: true });
  }
  rmSync(manifestPath, { force: true });
  return true;
}

function computeOverlayDigest(overlayFiles, patches) {
  const h = createHash('sha256');
  const rev = readRevision();
  h.update(`revision:${rev.revision}\n`);
  for (const rel of overlayFiles) {
    const digest = sha256File(join(OVERLAY_DIR, rel));
    h.update(`overlay:${rel}:${digest}\n`);
  }
  for (const patch of patches) {
    const digest = sha256File(join(PATCHES_DIR, patch));
    h.update(`patch:${patch}:${digest}\n`);
  }
  return h.digest('hex');
}

function extractPatchedFiles(patchContent) {
  const files = new Set();
  for (const line of patchContent.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') files.add(m[1]);
  }
  return [...files];
}

function writeIfChanged(dstPath, contentBuf) {
  if (existsSync(dstPath)) {
    const existing = readFileSync(dstPath);
    if (existing.equals(contentBuf)) return false;
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, contentBuf);
  return true;
}

function applyOverlay(srcDir, { dryRun = false } = {}) {
  const rev = readRevision();
  verifyPinnedHead(srcDir, rev);
  const overlayFiles = walkFiles(OVERLAY_DIR);
  const patches = listPatches();
  const overlayDigest = computeOverlayDigest(overlayFiles, patches);
  const buildId = `${dubCommit()}-${overlayDigest.slice(0, 12)}`;

  if (dryRun) {
    const dirty = parseDirtyPaths(srcDir);
    const manifestPath = join(srcDir, MANIFEST_FILENAME);
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const allowed = new Set([...(manifest.overlayFiles || []), ...(manifest.patchedFiles || [])]);
      const unexpected = dirty.filter(d => !allowed.has(d.path));
      if (unexpected.length > 0) {
        throw new Error(`Unrelated dirty files:\n${unexpected.map(d => `  ${d.code} ${d.path}`).join('\n')}`);
      }
      console.log(JSON.stringify({
        status: 'applied',
        revision: rev.revision,
        appliedBuildId: manifest.buildId,
        expectedBuildId: buildId,
        upToDate: manifest.overlayDigest === overlayDigest,
        overlayCount: overlayFiles.length,
        patchCount: patches.length,
      }, null, 2));
      return;
    }
    if (dirty.length > 0) {
      throw new Error(`Upstream tree is dirty:\n${dirty.map(d => `  ${d.code} ${d.path}`).join('\n')}`);
    }
    for (const patch of patches) {
      git(srcDir, ['apply', '--check', join(PATCHES_DIR, patch)]);
    }
    console.log(JSON.stringify({
      status: 'clean-ready',
      revision: rev.revision,
      expectedBuildId: buildId,
      overlayCount: overlayFiles.length,
      patchCount: patches.length,
    }, null, 2));
    return;
  }

  const manifestPath = join(srcDir, MANIFEST_FILENAME);
  const prevManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const patchHashes = {};
  for (const patch of patches) {
    patchHashes[patch] = sha256File(join(PATCHES_DIR, patch));
  }
  const patchesIdentical =
    prevManifest &&
    JSON.stringify(prevManifest.patches || []) === JSON.stringify(patches) &&
    JSON.stringify(prevManifest.patchHashes || {}) === JSON.stringify(patchHashes);

  let patchedFiles = new Set();
  if (patchesIdentical) {
    // Fast incremental path: keep already-applied patches untouched to preserve
    // header mtimes for ninja/siso, while still refusing unrelated dirty files.
    const allowed = new Set([...(prevManifest.overlayFiles || []), ...(prevManifest.patchedFiles || [])]);
    const dirty = parseDirtyPaths(srcDir);
    const unknown = dirty.filter(d => !allowed.has(d.path));
    if (unknown.length > 0) {
      throw new Error(
        `Refusing to overwrite unrelated dirty files in ${srcDir}:\n` +
          unknown.slice(0, 20).map(d => `  ${d.code} ${d.path}`).join('\n')
      );
    }
    // Remove any previously copied overlay files that no longer exist.
    const nextOverlaySet = new Set([...overlayFiles, 'chrome/browser/dub/dub_build_info.h']);
    for (const oldRel of prevManifest.overlayFiles || []) {
      if (!nextOverlaySet.has(oldRel)) rmSync(join(srcDir, oldRel), { force: true });
    }
    patchedFiles = new Set(prevManifest.patchedFiles || []);
  } else {
    revertExistingOverlay(srcDir);
    const stillDirty = parseDirtyPaths(srcDir);
    if (stillDirty.length > 0) {
      throw new Error(`Tree is still dirty after revert:\n${stillDirty.map(d => `  ${d.code} ${d.path}`).join('\n')}`);
    }
    for (const patch of patches) {
      const patchPath = join(PATCHES_DIR, patch);
      const patchText = readFileSync(patchPath, 'utf8');
      git(srcDir, ['apply', '--check', patchPath]);
      git(srcDir, ['apply', patchPath]);
      for (const f of extractPatchedFiles(patchText)) patchedFiles.add(f);
    }
  }

  const copiedFiles = [];
  const overlayHashes = {};
  for (const rel of overlayFiles) {
    const srcFile = join(OVERLAY_DIR, rel);
    const dstFile = join(srcDir, rel);
    const buf = readFileSync(srcFile);
    writeIfChanged(dstFile, buf);
    copiedFiles.push(rel);
    overlayHashes[rel] = sha256Buffer(buf);
  }

  const generatedHeaderRel = 'chrome/browser/dub/dub_build_info.h';
  const generatedHeaderPath = join(srcDir, generatedHeaderRel);
  const generatedBuf = Buffer.from(
    `// Auto-generated by scripts/chromium.mjs. Do not edit.\n` +
      `#ifndef CHROME_BROWSER_DUB_DUB_BUILD_INFO_H_\n` +
      `#define CHROME_BROWSER_DUB_DUB_BUILD_INFO_H_\n` +
      `namespace dub {\n` +
      `inline constexpr char kDubChromiumRevision[] = "${rev.revision}";\n` +
      `inline constexpr char kDubChromiumVersion[] = "${rev.version}";\n` +
      `inline constexpr char kDubBuildId[] = "${buildId}";\n` +
      `inline constexpr int kDubProtocolVersion = ${rev.protocol};\n` +
      `}  // namespace dub\n` +
      `#endif\n`
  );
  writeIfChanged(generatedHeaderPath, generatedBuf);
  copiedFiles.push(generatedHeaderRel);
  overlayHashes[generatedHeaderRel] = sha256Buffer(generatedBuf);

  const diffOut = git(srcDir, ['diff', 'HEAD']).stdout;
  const manifest = {
    appliedAt: new Date().toISOString(),
    dubCommit: dubCommit(),
    chromiumRevision: rev.revision,
    chromiumVersion: rev.version,
    buildId,
    overlayDigest,
    diffSha256: sha256Buffer(Buffer.from(diffOut)),
    overlayFiles: copiedFiles,
    overlayHashes,
    patches,
    patchHashes,
    patchedFiles: [...patchedFiles].sort(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Applied Dub overlay (${copiedFiles.length} files, ${patches.length} patches, buildId=${buildId}${patchesIdentical ? ', incremental' : ''}).`);
  return manifest;
}

function hasBinary(name) {
  const res = spawnSync('which', [name], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function buildGnArgs(opts) {
  const lines = [
    'is_debug = false',
    'is_official_build = false',
    'use_remoteexec = false',
    'symbol_level = 0',
    'blink_symbol_level = 0',
    'v8_symbol_level = 0',
    'use_thin_lto = false',
  ];
  if (opts.profile === 'dev') {
    lines.push('is_component_build = true', 'dcheck_always_on = true');
  } else if (opts.profile === 'release') {
    lines.push('is_component_build = false', 'dcheck_always_on = false');
  } else {
    throw new Error(`Unknown --profile: ${opts.profile} (expected dev or release)`);
  }
  const useSccache = opts.sccache === 'on' || (opts.sccache === 'auto' && hasBinary('sccache'));
  if (useSccache) {
    lines.push('cc_wrapper = "sccache"');
  }
  return lines.join('\n') + '\n';
}

function buildChromium(opts) {
  const manifest = opts.noApply
    ? JSON.parse(readFileSync(join(opts.src, MANIFEST_FILENAME), 'utf8'))
    : applyOverlay(opts.src);
  const outDir = resolve(opts.src, opts.out);
  mkdirSync(outDir, { recursive: true });
  const gnArgs = buildGnArgs(opts);
  writeFileSync(join(outDir, 'args.gn'), gnArgs);

  console.log(`=== gn gen ${opts.out} --check ===`);
  run('gn', ['gen', opts.out, '--check'], { cwd: opts.src });

  console.log(`=== autoninja -C ${opts.out} ${opts.target} ===`);
  const startedAt = Date.now();
  const ninjaArgs = ['-C', opts.out];
  if (opts.jobs) ninjaArgs.push('-j', String(opts.jobs));
  ninjaArgs.push(opts.target);
  run('autoninja', ninjaArgs, { cwd: opts.src });
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  const binaryPath = join(outDir, opts.target);
  const receipt = {
    builtAt: new Date().toISOString(),
    elapsedSec,
    target: opts.target,
    profile: opts.profile,
    outDir,
    gnArgs: gnArgs.trim().split('\n'),
    manifest,
    binaryPath: existsSync(binaryPath) ? binaryPath : null,
    binarySha256: existsSync(binaryPath) && statSync(binaryPath).isFile() ? sha256File(binaryPath) : null,
  };
  writeFileSync(join(outDir, 'dub-build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Build succeeded in ${elapsedSec}s: ${binaryPath} (sha256=${receipt.binarySha256})`);
}

function fetchChromium(opts) {
  const rev = readRevision();
  const rootDir = dirname(opts.src);
  mkdirSync(rootDir, { recursive: true });
  const gclientPath = join(rootDir, '.gclient');
  if (!existsSync(gclientPath)) {
    writeFileSync(
      gclientPath,
      `solutions = [\n  {\n    "name": "src",\n    "url": "${rev.repository}",\n    "managed": False,\n    "custom_deps": {},\n    "custom_vars": {},\n  },\n]\n`
    );
  }
  if (!existsSync(join(opts.src, '.git'))) {
    run('git', ['init', opts.src]);
    run('git', ['-C', opts.src, 'remote', 'add', 'origin', rev.repository]);
  }
  run('git', ['-C', opts.src, 'fetch', '--depth=1', 'origin', rev.revision]);
  run('git', ['-C', opts.src, 'checkout', '--force', 'FETCH_HEAD']);
  run('gclient', ['sync', '--no-history', '--nohooks', '--force', '--delete_unversioned_trees', '--revision', `src@${rev.revision}`, '-j', '32'], { cwd: rootDir });
  run('gclient', ['runhooks'], { cwd: rootDir });
}

function main() {
  const { action, opts } = parseArgs(process.argv.slice(2));
  if (!action || action === '--help' || action === '-h') {
    console.log(
      'Usage: node scripts/chromium.mjs <fetch|check|apply|revert|build|status> [--src DIR] [--out out/Default] [--target chrome] [--profile dev|release] [--sccache auto|on|off]'
    );
    return;
  }
  if (action === 'fetch') return fetchChromium(opts);
  if (action === 'check' || action === 'status') return applyOverlay(opts.src, { dryRun: true });
  if (action === 'apply') return applyOverlay(opts.src);
  if (action === 'revert') {
    const rev = readRevision();
    verifyPinnedHead(opts.src, rev);
    const reverted = revertExistingOverlay(opts.src);
    console.log(reverted ? 'Reverted Dub overlay cleanly.' : 'No Dub overlay manifest found; tree is clean.');
    return;
  }
  if (action === 'build') return buildChromium(opts);
  throw new Error(`Unknown action: ${action}`);
}

main();

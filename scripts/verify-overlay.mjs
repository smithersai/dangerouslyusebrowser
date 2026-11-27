import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function fail(message) {
  console.error(`overlay-check FAIL: ${message}`);
  process.exitCode = 1;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files.sort();
}

const revisionPath = resolve(root, 'chromium/revision.json');
if (!existsSync(revisionPath)) {
  fail('chromium/revision.json is missing');
} else {
  const rev = JSON.parse(readFileSync(revisionPath, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(rev.revision ?? '')) {
    fail(`chromium/revision.json revision must be a 40-char hex SHA, got: ${rev.revision}`);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(rev.version ?? '')) {
    fail(`chromium/revision.json version must be Chromium dotted quad, got: ${rev.version}`);
  }
  if (rev.protocol !== 1) {
    fail(`chromium/revision.json protocol must be 1, got: ${rev.protocol}`);
  }
}

const overlayDir = resolve(root, 'chromium/overlay');
const patchesDir = resolve(root, 'chromium/patches');
const overlayFiles = walk(overlayDir);
const patchFiles = walk(patchesDir).filter(f => f.endsWith('.patch'));

if (overlayFiles.length < 15) {
  fail(`Expected at least 15 Chromium overlay files, found ${overlayFiles.length}`);
}
if (patchFiles.length < 5) {
  fail(`Expected at least 5 Chromium patches (Stage A + M1..M4), found ${patchFiles.length}`);
}

const privatePatterns = [
  /hetzner/i,
  /latitude\.sh/i,
  /nyc-0[12]/i,
  /tailscale/i,
  /jjhub/i,
  /\/Users\/williamcory/i,
];

for (const patchFile of patchFiles) {
  const rel = relative(root, patchFile);
  const content = readFileSync(patchFile, 'utf8');
  if (!content.includes('--- a/') || !content.includes('+++ b/')) {
    fail(`${rel} is not a unified git/jj diff with --- a/ and +++ b/ headers`);
  }
  if (statSync(patchFile).size === 0) {
    fail(`${rel} is empty`);
  }
  for (const pat of privatePatterns) {
    if (pat.test(content)) fail(`${rel} leaks private infrastructure reference matching ${pat}`);
  }
}

for (const overlayFile of overlayFiles) {
  const rel = relative(root, overlayFile);
  const content = readFileSync(overlayFile, 'utf8');
  if (statSync(overlayFile).size === 0) {
    fail(`${rel} is empty`);
  }
  for (const pat of privatePatterns) {
    if (pat.test(content)) fail(`${rel} leaks private infrastructure reference matching ${pat}`);
  }
}

if (!process.exitCode) {
  console.log(
    JSON.stringify({
      ok: true,
      overlayFiles: overlayFiles.length,
      patchFiles: patchFiles.length,
      patches: patchFiles.map(f => relative(root, f)),
    })
  );
}

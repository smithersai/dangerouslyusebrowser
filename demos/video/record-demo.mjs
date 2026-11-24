#!/usr/bin/env node
/**
 * End-to-end demo video builder for Dub (DangerouslyUseBrowser).
 *
 * 1. Captures real PNG screenshots from the compiled Dub Chromium 157 fork (capture-frames.mjs)
 *    unless --render-only is passed and captures/ already exists.
 * 2. Composites the 1280x720 @ 30fps H.264 yuv420p MP4 (render-video.py -> demos/video/dub-demo.mp4).
 *
 * Usage:
 *   # Full capture + render (when running on a machine with Dub Chromium built):
 *   DUB_BROWSER=/path/to/chrome node demos/video/record-demo.mjs
 *
 *   # Render only from already-captured real Dub screenshots in demos/video/captures/:
 *   node demos/video/record-demo.mjs --render-only
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const renderOnly = process.argv.includes('--render-only');

if (!renderOnly) {
  if (!process.env.DUB_BROWSER) {
    console.error('Set DUB_BROWSER=/path/to/chrome or pass --render-only to use existing demos/video/captures/.');
    process.exit(1);
  }
  const cap = spawnSync(process.execPath, [join(dir, 'capture-frames.mjs'), '--out-dir', join(dir, 'captures')], {
    stdio: 'inherit',
    env: process.env,
  });
  if (cap.status !== 0) process.exit(cap.status ?? 1);
}

const ren = spawnSync('python3', [join(dir, 'render-video.py')], { stdio: 'inherit' });
if (ren.status !== 0) process.exit(ren.status ?? 1);

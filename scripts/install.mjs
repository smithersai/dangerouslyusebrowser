// Installing the package never launches a browser.
// Uses shipped prebuild when available; otherwise compiles native/addon.cc on demand.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const localBuild = new URL('../build/Release/dub.node', import.meta.url);
const prebuild = new URL(`../prebuilds/${process.platform}-${process.arch}/dub.node`, import.meta.url);

if (!existsSync(localBuild) && !existsSync(prebuild)) {
  const buildScript = fileURLToPath(new URL('./build-native.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('Dub: native bridge build failed; run "npm run build:native" with Node headers and a C++20 compiler.');
  }
}

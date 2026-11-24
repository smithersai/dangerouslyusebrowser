import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Dub currently supports Linux and macOS.');
const headers = [process.env.NODE_INCLUDE_DIR, resolve(dirname(process.execPath), '../include/node'), '/usr/include/node', '/opt/homebrew/include/node'].find(p => p && existsSync(resolve(p, 'node_api.h')));
if (!headers) throw new Error('Node headers missing. Set NODE_INCLUDE_DIR to the directory containing node_api.h.');
mkdirSync(resolve(root, 'build/Release'), { recursive: true });
const args = ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=dub', `-I${headers}`, 'native/addon.cc', 'native/dub.cc', '-o', 'build/Release/dub.node'];
if (process.platform === 'darwin') args.push('-undefined', 'dynamic_lookup');
const result = spawnSync(process.env.CXX || 'c++', args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else if (process.argv.includes('--prebuild')) {
  const prebuildDir = resolve(root, `prebuilds/${process.platform}-${process.arch}`);
  mkdirSync(prebuildDir, { recursive: true });
  copyFileSync(resolve(root, 'build/Release/dub.node'), resolve(prebuildDir, 'dub.node'));
}

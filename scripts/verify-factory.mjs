import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const factoryJsonPath = resolve(root, '.smithers/factory.json');

if (!existsSync(factoryJsonPath)) {
  console.error('factory-check FAIL: .smithers/factory.json is missing');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(factoryJsonPath, 'utf8'));

if (!manifest.summary || typeof manifest.summary !== 'string') {
  console.error('factory-check FAIL: missing factory summary');
  process.exit(1);
}
if (!Array.isArray(manifest.flows) || manifest.flows.length < 8) {
  console.error(`factory-check FAIL: expected at least 8 flows, found ${manifest.flows?.length ?? 0}`);
  process.exit(1);
}

for (const flow of manifest.flows) {
  const flowPath = resolve(root, flow.path);
  if (!existsSync(flowPath)) {
    console.error(`factory-check FAIL: flow "${flow.id}" points to missing file ${flow.path}`);
    process.exit(1);
  }
}

const gh = manifest.github ?? {};
if (!Array.isArray(gh.maintainers) || !gh.maintainers.includes('roninjin10')) {
  console.error('factory-check FAIL: github.maintainers must include roninjin10');
  process.exit(1);
}
for (const requiredProtected of ['.github', '.smithers', '.agents', 'chromium/patches', 'native']) {
  if (!Array.isArray(gh.protectedPaths) || !gh.protectedPaths.includes(requiredProtected)) {
    console.error(`factory-check FAIL: github.protectedPaths missing "${requiredProtected}"`);
    process.exit(1);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    flows: manifest.flows.map(f => f.id),
    maintainers: gh.maintainers,
    protectedPaths: gh.protectedPaths.length,
    triggers: Array.isArray(manifest.on) ? manifest.on.length : Object.keys(manifest.on ?? {}).length,
  })
);

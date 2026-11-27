import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, lineCount, ROOT, walkFiles } from './_lib.ts';

const srcFiles = [
  ...walkFiles(join(ROOT, 'src'), ['.ts']),
  ...walkFiles(join(ROOT, 'native'), ['.cc', '.h']),
];
const testFiles = walkFiles(join(ROOT, 'tests'), ['.mjs', '.ts']);

const srcLines = srcFiles.reduce((acc, f) => acc + lineCount(f), 0);
const testLines = testFiles.reduce((acc, f) => acc + lineCount(f), 0);
const ratio = srcLines > 0 ? Math.round((testLines / srcLines) * 100) : 0;
emit('test-to-src-ratio', ratio, {
  item: 'dub',
  target: 55,
  note: `${ratio}% (${testLines} test lines / ${srcLines} src+native lines)`,
});

const fuzzPath = join(ROOT, 'tests/fuzz.test.mjs');
const fuzzSource = existsSync(fuzzPath) ? readFileSync(fuzzPath, 'utf8') : '';
const fuzzCount = (fuzzSource.match(/\btest\s*\(/g) ?? []).length;
emit('fuzz-tests', fuzzCount, { item: 'tests/fuzz.test.mjs', target: 5 });

const unitFiles = testFiles.filter(f => !f.startsWith('tests/browser/'));
let unitCount = 0;
for (const f of unitFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  unitCount += (src.match(/\btest\s*\(/g) ?? []).length;
}
emit('unit-tests', unitCount, { item: 'tests/*.test.mjs', target: 25 });

const browserSuites = testFiles.filter(f => f.startsWith('tests/browser/') && f.endsWith('.test.mjs'));
emit('browser-acceptance-suites', browserSuites.length, { item: 'tests/browser', target: 5 });

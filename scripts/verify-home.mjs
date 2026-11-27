import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Home } from '@smthrs/views';

const root = fileURLToPath(new URL('..', import.meta.url));
const homePath = resolve(root, '.smithers/home.json');
const text = readFileSync(homePath, 'utf8');
const parsed = Home.read(text);

if (parsed._tag !== 'Declared') {
  console.error(`home-check FAIL: .smithers/home.json is invalid (${parsed.reason})`);
  process.exit(1);
}
if (parsed.skipped > 0) {
  console.error(`home-check FAIL: .smithers/home.json contains ${parsed.skipped} unknown block(s)`);
  process.exit(1);
}

const audiences = new Set(parsed.sections.map(s => s.audience));
for (const required of ['maintainer', 'contributor', 'everyone']) {
  if (!audiences.has(required)) {
    console.error(`home-check FAIL: .smithers/home.json is missing required audience section "${required}"`);
    process.exit(1);
  }
}

// Enforce public copy rules: no em dashes or semicolons in non-code home prose.
for (const section of parsed.sections) {
  for (const block of section.blocks) {
    if (block.type === 'code') continue;
    const serialized = JSON.stringify(block);
    if (serialized.includes('\u2014') || serialized.includes(';')) {
      console.error(`home-check FAIL: non-code block in "${section.audience}" contains semicolon or em dash`);
      process.exit(1);
    }
  }
}

console.log(
  JSON.stringify({
    ok: true,
    docs: parsed.docs ?? null,
    contributors: parsed.contributors,
    sections: parsed.sections.map(s => ({ title: s.title ?? null, audience: s.audience, blocks: s.blocks.length })),
  })
);

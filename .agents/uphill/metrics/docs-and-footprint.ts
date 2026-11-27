import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emit, fileBytes, formatBytes, ROOT, walkFiles } from './_lib.ts';

// 1. Prebuilt N-API binary footprint
for (const prebuild of walkFiles(join(ROOT, 'prebuilds'), ['.node'])) {
  const bytes = fileBytes(prebuild);
  emit('prebuild-size', formatBytes(bytes), { item: prebuild, target: '160kB' });
}

// 2. Relative Markdown link validation across public docs and wiki
const mdFiles = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  ...walkFiles(join(ROOT, 'docs'), ['.md']),
  ...walkFiles(join(ROOT, '.smithers/wiki'), ['.md']),
].filter(f => existsSync(join(ROOT, f)));

let brokenLink: string | undefined;
const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
for (const mdFile of mdFiles) {
  const raw = readFileSync(join(ROOT, mdFile), 'utf8');
  const stripped = raw.replace(/```[\s\S]*?```/g, '');
  for (const match of stripped.matchAll(linkRe)) {
    const href = match[1]!.trim();
    if (!href || /^(?:https?:|mailto:|#|file:)/i.test(href)) continue;
    const clean = href.split('#')[0]!.split('?')[0]!;
    if (!clean) continue;
    const targetPath = resolve(dirname(join(ROOT, mdFile)), clean);
    if (!existsSync(targetPath)) {
      brokenLink = `${mdFile} -> ${href}`;
      break;
    }
  }
  if (brokenLink) break;
}
emit('markdown-links', brokenLink ? 'fail' : 'pass', { item: 'docs+wiki', note: brokenLink });

// 3. Factory knowledge artifacts: wiki catalog, mythical history, home.json, llms.txt
const requiredKnowledge = [
  '.smithers/coding-project.json',
  '.smithers/wiki/README.md',
  '.smithers/wiki/mythical-history.md',
  '.smithers/home.json',
  '.smithers/factory.json',
  'site/llms.txt',
  'site/audit.html',
];
const missing = requiredKnowledge.filter(p => !existsSync(join(ROOT, p)));
emit('factory-knowledge', missing.length === 0 ? 'pass' : 'fail', {
  item: 'knowledge-graph',
  note: missing.length > 0 ? `Missing: ${missing.join(', ')}` : undefined,
});

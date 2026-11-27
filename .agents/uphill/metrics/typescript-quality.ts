import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, ROOT, walkFiles } from './_lib.ts';

function stripCommentsAndStrings(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function longestFunctionLines(source: string): { name: string; startLine: number; lines: number } {
  const lines = source.split(/\r?\n/);
  let worst = { name: 'none', startLine: 1, lines: 1 };
  let depth = 0;
  let active: { name: string; startLine: number; baseDepth: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const cleaned = stripCommentsAndStrings(raw);
    const open = (cleaned.match(/\{/g) ?? []).length;
    const close = (cleaned.match(/\}/g) ?? []).length;

    if (!active) {
      const fnMatch =
        /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(cleaned) ??
        /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::[^{]+)?\{/.exec(cleaned);
      if (fnMatch && open > 0 && !['if', 'for', 'while', 'switch', 'catch'].includes(fnMatch[1]!)) {
        active = { name: fnMatch[1]!, startLine: i + 1, baseDepth: depth };
      }
    }

    depth += open - close;

    if (active && depth <= active.baseDepth) {
      const span = i + 1 - active.startLine + 1;
      if (span > worst.lines) worst = { name: active.name, startLine: active.startLine, lines: span };
      active = null;
    }
  }
  return worst;
}

const srcFiles = walkFiles(join(ROOT, 'src'), ['.ts']).filter(f => !f.endsWith('.d.ts'));

for (const file of srcFiles) {
  const raw = readFileSync(join(ROOT, file), 'utf8');
  const lines = raw.split(/\r?\n/);

  let anyHit: string | undefined;
  let suppressHit: string | undefined;
  let consoleHit: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!suppressHit && /@ts-(?:ignore|expect-error|nocheck)\b/.test(line)) {
      suppressHit = `${file}:${i + 1}: ${trimmed.slice(0, 72)}`;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const code = stripCommentsAndStrings(line);
    if (!anyHit && /(?:[:<]\s*any\b|\bas\s+any\b)/.test(code)) {
      anyHit = `${file}:${i + 1}: explicit any`;
    }
    if (!consoleHit && file !== 'src/cli.ts' && /\bconsole\.log\s*\(/.test(code)) {
      consoleHit = `${file}:${i + 1}: console.log in library code`;
    }
  }

  emit('ts-no-explicit-any', anyHit ? 'fail' : 'pass', { item: file, note: anyHit });
  emit('ts-no-suppressions', suppressHit ? 'fail' : 'pass', { item: file, note: suppressHit });
  emit('ts-no-console-log', consoleHit ? 'fail' : 'pass', { item: file, note: consoleHit });

  const longest = longestFunctionLines(raw);
  emit('ts-max-fn-lines', longest.lines, {
    item: file,
    target: 110,
    note: longest.lines > 110 ? `${file}:${longest.startLine} ${longest.name} (${longest.lines} lines)` : undefined,
  });
}

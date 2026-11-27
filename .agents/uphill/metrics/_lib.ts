import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = process.cwd();

export function metricsPath(): string {
  const p = process.env.UPHILL_METRICS;
  if (!p) throw new Error('UPHILL_METRICS environment variable is not set');
  return p;
}

export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export function emit(
  metric: string,
  value: string | number,
  opts?: { item?: string; target?: string | number; note?: string }
): void {
  const parts = [metric];
  if (opts?.item !== undefined) parts.push(quote(opts.item));
  parts.push(String(value));
  if (opts?.target !== undefined) parts.push('target', String(opts.target));
  if (opts?.note !== undefined) parts.push('note', quote(opts.note));
  appendFileSync(metricsPath(), `${parts.join(' ')}\n`);
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-release',
  'build',
  '.git',
  '.jj',
  '.local',
  '.uphill',
  '.flows',
  '.wrangler',
  'artifacts',
  'cache',
  'reports',
  'state',
  'tmp',
  'pg',
]);

export function walkFiles(dir: string, exts?: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts));
    } else if (!exts || exts.some(ext => entry.name.endsWith(ext))) {
      out.push(relative(ROOT, full));
    }
  }
  return out.sort();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)}MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}kB`;
  return `${bytes}B`;
}

export function lineCount(relPath: string): number {
  return readFileSync(join(ROOT, relPath), 'utf8').split(/\r?\n/).length;
}

export function fileBytes(relPath: string): number {
  return statSync(join(ROOT, relPath)).size;
}

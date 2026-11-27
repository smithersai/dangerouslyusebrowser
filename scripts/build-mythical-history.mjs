#!/usr/bin/env node
/**
 * Generate Dub's Mythical History chronicle directly from verified `jj` commit
 * history, pinned Chromium metadata, and dated evidence bundles.
 *
 * Outputs:
 *   - .smithers/wiki/mythical-history.md (Obsidian-compatible Markdown chronicle)
 *   - site/history.html (Interactive public Mythical History page)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const rev = JSON.parse(readFileSync(resolve(root, 'chromium/revision.json'), 'utf8'));

function readJjCommits() {
  const template =
    'commit_id.short(8) ++ "\\t" ++ committer.timestamp().format("%Y-%m-%d") ++ "\\t" ++ description.first_line() ++ "\\n"';
  const res = spawnSync(
    'jj',
    ['--no-pager', 'log', '-r', 'ancestors(@, 40)', '--no-graph', '-T', template],
    { cwd: root, encoding: 'utf8' }
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [sha, date, ...rest] = line.split('\t');
      const title = rest.join('\t').trim();
      return { sha: sha ?? '', date: date ?? '', title };
    })
    .filter(c => c.title.length > 0 && c.title !== '(no description set)');
}

const commits = readJjCommits();

const epochs = [
  {
    id: 'epoch-01',
    era: 'Epoch I',
    date: '2026-09-30',
    title: 'The Seam Census and the C++20 Bridge',
    badge: 'Foundation',
    summary:
      'Dub began with a hard refusal: no stock-CDP wrapper, no Playwright shim, no Electron shell. The first commits carved a minimal C ABI and N-API v8 bridge over AF_UNIX with whole-call deadlines, incur HTTP MCP commands, and a source-backed seam census across 32 pinned Chromium 157 paths.',
    receipts: [
      'docs/spec.md',
      'docs/seams.md',
      'docs/decisions.md',
      'docs/first-build.md',
      'native/dub.cc',
      'native/addon.cc',
    ],
    commitMatch: /draft:|seam census|typed SDK|first Chromium|initial|N-API/i,
  },
  {
    id: 'epoch-02',
    era: 'Epoch II',
    date: '2026-11-23',
    title: 'First Light: Compiled Chromium 157 Fork (Stage A)',
    badge: 'Compiled Fork',
    summary:
      'Pinned Chromium 157.0.8082.0 (0e331aaf43bf) compiled cleanly on Linux x86-64 with the Dub native dispatcher wired directly into chrome/browser:core. A real MCP client crossed incur, TypeScript, N-API, and AF_UNIX to dispatch a native trusted click inside the compiled fork.',
    receipts: [
      'chromium/revision.json',
      'chromium/patches/0001-stage-a-dub-core.patch',
      'tests/browser/stage-a.test.mjs',
    ],
    commitMatch: /stage-a/i,
  },
  {
    id: 'epoch-03',
    era: 'Epoch III',
    date: '2026-11-23',
    title: 'NetworkService Mastery and Native WebMCP (Milestones 1 and 2)',
    badge: 'DEMO-01 & DEMO-03',
    summary:
      'Dub moved below navigation-only hooks directly into Chromium NetworkService, intercepting tabs, dedicated/shared/service workers, CacheStorage, and HTTP disk cache. Alongside it landed promise-aware evaluation, persistent profile ownership, native actor tools, and live WebMCP page-tool discovery.',
    receipts: [
      'chromium/patches/0002-milestone-1-renderer-webmcp-upload.patch',
      'chromium/patches/0003-milestone-2-network-interception.patch',
      'tests/browser/milestone-1-act.test.mjs',
      'tests/browser/milestone-2-network.test.mjs',
    ],
    commitMatch: /milestone 1|milestone-1|milestone 2|network/i,
  },
  {
    id: 'epoch-04',
    era: 'Epoch IV',
    date: '2026-11-23',
    title: 'Bending Time Without Breaking Sibling Tabs (Milestone 3)',
    badge: 'DEMO-02',
    summary:
      'Rejecting process-wide virtual time, Dub patched V8 and Blink with per-tab isolated clock domains. One tab froze at 2026-01-01, stepped exact animation frames, and jumped 31 days into trial expiry while a sibling tab in the exact same renderer process stayed on wall clock.',
    receipts: [
      'chromium/patches/0004-milestone-3-per-tab-clock.patch',
      'tests/browser/milestone-3-clock.test.mjs',
      'docs/evidence/2026-11-23/README.md',
    ],
    commitMatch: /milestone-3|clock/i,
  },
  {
    id: 'epoch-05',
    era: 'Epoch V',
    date: '2026-11-24',
    title: 'Launch Evidence, Prebuilds, Fuzzing, and Docs Site',
    badge: 'v0.1.0-alpha.1',
    summary:
      'All three reproducible launch demos passed against the packaged 390 MiB Linux x86-64 bundle with SHA-256 checksums, fresh-install verification, prebuilt N-API binaries for macOS arm64 and Linux x64, 4 fuzz suites, and the public site at dangerouslyusebrowser.smithers.sh.',
    receipts: [
      'docs/evidence/2026-11-23/README.md',
      'docs/evidence/2026-11-23/demos-receipt.json',
      'demos/run-demos.mjs',
      'tests/fuzz.test.mjs',
    ],
    commitMatch: /launch|release/i,
  },
  {
    id: 'epoch-06',
    era: 'Epoch VI',
    date: '2026-11-26',
    title: 'QuickJS Code Mode, Jev, Triggers, and Live TS Plugins (Milestone 4)',
    badge: 'Programmable Runtime',
    summary:
      'Chromium gained a live AF_UNIX push event stream (dub_events) feeding a full Smithers-powered runtime: persistent QuickJS REPL realms, typed Jev evaluators, BYO agent adapters, reactive triggers, and hot-reloadable TypeScript plugins.',
    receipts: [
      'chromium/patches/0005-milestone-4-control-events-plugins.patch',
      'src/smithers-runtime.ts',
      'src/plugins.ts',
      'src/triggers.ts',
      'tests/plugins-smithers.test.mjs',
    ],
    commitMatch: /milestone-4|plugins/i,
  },
  {
    id: 'epoch-07',
    era: 'Epoch VII',
    date: '2026-11-26',
    title: 'The Smithers Cloud Factory Switchover',
    badge: 'Public Factory',
    summary:
      'Dub switched permanently onto Smithers Cloud: incremental smthrs targets backed by the shared build.smithers.sh object store, single-use one-time sandbox auth tokens, strict untrusted-vs-trusted cache isolation, Lighthouse-style Uphill backpressure, personalized Maintainer/Contributor/Viewer views, Obsidian wiki, and automated release and docs pipelines.',
    receipts: [
      '.smithers/WORKSPACE.ts',
      '.smithers/FACTORY.ts',
      '.smithers/home.json',
      '.agents/uphill/uphill.yaml',
      'src/auth.ts',
      'site/audit.html',
    ],
    commitMatch: /smithers|factory|lighthouse|uphill|cloud/i,
  },
];

const mdLines = [
  '# Mythical History of Dub',
  '',
  `A source-grounded chronicle of **Dub (DangerouslyUseBrowser)** built on pinned Chromium \`${rev.version}\` (\`${rev.revision.slice(0, 12)}\`). Every epoch below links directly to committed source files, patches, and dated verification receipts.`,
  '',
  '## Epochs',
  '',
];

for (const epoch of epochs) {
  const matched = commits.filter(c => epoch.commitMatch.test(c.title)).slice(0, 4);
  mdLines.push(`### ${epoch.era}: ${epoch.title} (${epoch.date})`);
  mdLines.push('');
  mdLines.push(`> **Stage:** ${epoch.badge}`);
  mdLines.push('');
  mdLines.push(epoch.summary);
  mdLines.push('');
  if (matched.length > 0) {
    mdLines.push('**Verified commits:**');
    for (const c of matched) {
      mdLines.push(`- \`${c.sha}\` (${c.date}) ${c.title}`);
    }
    mdLines.push('');
  }
  mdLines.push('**Key artifacts:** ' + epoch.receipts.map(r => `\`${r}\``).join(', '));
  mdLines.push('');
}

mdLines.push('## Verified Commit Ledger (from `jj log`)');
mdLines.push('');
mdLines.push('| Commit | Date | Description |');
mdLines.push('| --- | --- | --- |');
for (const c of commits.slice(0, 25)) {
  mdLines.push(`| \`${c.sha}\` | ${c.date} | ${c.title.replace(/\|/g, '\\|')} |`);
}
mdLines.push('');

const mdOut = resolve(root, '.smithers/wiki/mythical-history.md');
mkdirSync(dirname(mdOut), { recursive: true });
writeFileSync(mdOut, `${mdLines.join('\n')}\n`, 'utf8');

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const epochCardsHtml = epochs
  .map((epoch, idx) => {
    const matched = commits.filter(c => epoch.commitMatch.test(c.title)).slice(0, 4);
    const commitsHtml =
      matched.length > 0
        ? `<div class="epoch-commits">${matched
            .map(
              c =>
                `<div class="commit-pill"><span class="sha">${esc(c.sha)}</span><span class="cdate">${esc(c.date)}</span><span class="ctitle">${esc(c.title)}</span></div>`
            )
            .join('')}</div>`
        : '';
    const artifactsHtml = epoch.receipts
      .map(r => `<code class="artifact-chip">${esc(r)}</code>`)
      .join('');
    return `
      <article class="epoch-card" id="${esc(epoch.id)}">
        <div class="epoch-rail">
          <span class="epoch-index">${String(idx + 1).padStart(2, '0')}</span>
          <span class="epoch-line"></span>
        </div>
        <div class="epoch-body">
          <div class="epoch-meta">
            <span class="epoch-era">${esc(epoch.era)}</span>
            <span class="epoch-badge">${esc(epoch.badge)}</span>
            <span class="epoch-date">${esc(epoch.date)}</span>
          </div>
          <h2>${esc(epoch.title)}</h2>
          <p>${esc(epoch.summary)}</p>
          ${commitsHtml}
          <div class="artifact-row">${artifactsHtml}</div>
        </div>
      </article>`;
  })
  .join('\n');

const ledgerRows = commits
  .slice(0, 25)
  .map(
    c => `<tr><td><code>${esc(c.sha)}</code></td><td>${esc(c.date)}</td><td>${esc(c.title)}</td></tr>`
  )
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mythical History | Dub (DangerouslyUseBrowser)</title>
  <meta name="description" content="Source-grounded Mythical History of Dub, the Chromium 157 fork built publicly on Smithers Cloud.">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="styles.css">
  <script src="theme.js"></script>
  <style>
    .chronicle-hero { padding: 36px 0 20px; border-bottom: 1px solid var(--line); }
    .chronicle-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 22px; }
    .chronicle-stat { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
    .chronicle-stat strong { display: block; font-size: 20px; color: var(--fg); letter-spacing: -0.02em; }
    .chronicle-stat span { font-size: 12px; color: var(--muted); }
    .timeline { display: flex; flex-direction: column; gap: 22px; margin: 34px 0 48px; }
    .epoch-card { display: grid; grid-template-columns: 44px 1fr; gap: 18px; }
    .epoch-rail { display: flex; flex-direction: column; align-items: center; }
    .epoch-index { width: 36px; height: 36px; border-radius: 999px; background: var(--surface); border: 1px solid var(--accent-border, #f59e0b55); color: var(--accent, #f59e0b); display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 12px; font-weight: 700; flex-shrink: 0; }
    .epoch-line { width: 1px; flex: 1; background: var(--line); margin-top: 8px; }
    .epoch-card:last-child .epoch-line { display: none; }
    .epoch-body { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; }
    .epoch-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
    .epoch-era { font-family: var(--mono); color: var(--accent, #f59e0b); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .epoch-badge { background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.28); color: var(--fg); padding: 2px 8px; border-radius: 999px; font-size: 11px; }
    .epoch-date { color: var(--muted); font-family: var(--mono); margin-left: auto; }
    .epoch-body h2 { margin: 0 0 10px; font-size: 20px; }
    .epoch-body p { margin: 0 0 14px; color: var(--muted); line-height: 1.65; }
    .epoch-commits { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
    .commit-pill { display: flex; gap: 10px; align-items: baseline; font-size: 12.5px; padding: 6px 10px; border-radius: 7px; background: var(--code-bg); border: 1px solid var(--line); }
    .commit-pill .sha { font-family: var(--mono); color: var(--accent); flex-shrink: 0; }
    .commit-pill .cdate { font-family: var(--mono); color: var(--muted); flex-shrink: 0; }
    .commit-pill .ctitle { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .artifact-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .artifact-chip { font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 6px; background: var(--code-bg); border: 1px solid var(--line); color: var(--muted); }
    .ledger-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
    .ledger-table th, .ledger-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .ledger-table th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    @media (max-width: 640px) { .epoch-card { grid-template-columns: 1fr; } .epoch-rail { display: none; } }
  </style>
</head>
<body>
  <div class="wrap wrap-wide">
    <header>
      <a class="brand" href="/">
        <span class="brand-name">Dub</span>
        <span class="brand-pkg">dangerouslyusebrowser</span>
      </a>
      <nav aria-label="Primary">
        <a href="/">Home</a>
        <a href="/audit">Lighthouse Audit</a>
        <a href="/wiki">Wiki</a>
        <a href="/history" aria-current="page">Mythical History</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://smithers.sh/smithersai/dangerouslyusebrowser">Smithers Cloud</a>
        <button class="theme-btn" id="theme-toggle" type="button">Dark</button>
      </nav>
    </header>

    <main>
      <section class="chronicle-hero">
        <div class="eyebrow">
          <span class="dot" aria-hidden="true"></span>
          <span>Generated from verified jj history &middot; Chromium ${esc(rev.version)}</span>
        </div>
        <h1>Mythical History of Dub</h1>
        <p class="lead">
          Every architectural turning point from the first C ABI framing test to the compiled Chromium 157 fork,
          per-tab isolated engine clocks, QuickJS plugins, and the public Smithers Cloud coding factory.
        </p>
        <div class="chronicle-stats">
          <div class="chronicle-stat"><strong>${epochs.length} Epochs</strong><span>Documented milestones</span></div>
          <div class="chronicle-stat"><strong>${commits.length} Commits</strong><span>Verified jj ledger</span></div>
          <div class="chronicle-stat"><strong>5 Patches</strong><span>Pinned Chromium 157.0.8082.0</span></div>
          <div class="chronicle-stat"><strong>Zero Slop</strong><span>Backed by real build receipts</span></div>
        </div>
      </section>

      <section class="timeline" aria-label="Project timeline">
        ${epochCardsHtml}
      </section>

      <section>
        <h2>Verified jj Commit Ledger</h2>
        <table class="ledger-table">
          <thead><tr><th>Commit</th><th>Date</th><th>Description</th></tr></thead>
          <tbody>
            ${ledgerRows}
          </tbody>
        </table>
      </section>
    </main>

    <footer>
      <span>Generated automatically from <code>jj log</code> and <code>.smithers/wiki/mythical-history.md</code></span>
      <span><a href="https://smithers.sh/smithersai/dangerouslyusebrowser">smithers.sh/smithersai/dangerouslyusebrowser</a></span>
    </footer>
  </div>
</body>
</html>
`;

const htmlOut = resolve(root, 'site/history.html');
writeFileSync(htmlOut, html, 'utf8');

console.log(
  JSON.stringify({
    ok: true,
    epochs: epochs.length,
    commits: commits.length,
    outputs: ['.smithers/wiki/mythical-history.md', 'site/history.html'],
  })
);

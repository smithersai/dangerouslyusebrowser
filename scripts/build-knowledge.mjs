#!/usr/bin/env node
/**
 * Build Dub's public knowledge graph from `.smithers/coding-project.json`,
 * `.smithers/wiki/pages/*.md`, `.smithers/wiki/mythical-history.md`, and `docs/`.
 *
 * Outputs:
 *   - site/docs/<id>.md     (same-origin Markdown pages for llms.txt & smithers.sh DocsSource)
 *   - site/llms.txt         (standard llms.txt index)
 *   - site/llms-full.txt    (full concatenated technical corpus for LLMs)
 *   - site/wiki.html        (interactive public Wiki UI)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogPath = resolve(root, '.smithers/coding-project.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const origin = 'https://dangerouslyusebrowser.smithers.sh';

const docsOutDir = resolve(root, 'site/docs');
mkdirSync(docsOutDir, { recursive: true });

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, (_, id, label) => `<a href="#page-${esc(id.trim())}" data-wiki-link="${esc(id.trim())}">${label}</a>`);
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, id) => `<a href="#page-${esc(id.trim())}" data-wiki-link="${esc(id.trim())}">${id}</a>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="local-ref">$1</span>');
  return out;
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  const flushList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  const flushTable = () => {
    if (!inTable) return;
    const [header, , ...body] = tableRows;
    const parseRow = row =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
    if (header) {
      html.push('<div class="wiki-table-wrap"><table class="wiki-table"><thead><tr>');
      for (const cell of parseRow(header)) html.push(`<th>${renderInline(cell)}</th>`);
      html.push('</tr></thead><tbody>');
      for (const row of body) {
        html.push('<tr>');
        for (const cell of parseRow(row)) html.push(`<td>${renderInline(cell)}</td>`);
        html.push('</tr>');
      }
      html.push('</tbody></table></div>');
    }
    inTable = false;
    tableRows = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushList();
      flushTable();
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        html.push(`<pre class="wiki-pre"><code class="lang-${esc(codeLang || 'text')}">${esc(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      flushList();
      inTable = true;
      tableRows.push(line);
      continue;
    }
    flushTable();

    if (/^#{1,4}\s+/.test(line)) {
      flushList();
      const level = line.match(/^(#+)/)[1].length;
      const content = line.slice(level + 1).trim();
      html.push(`<h${level}>${renderInline(content)}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInline(line.trim().slice(2))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line.trim())) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInline(line.trim().replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }
    flushList();

    if (line.trim().startsWith('> ')) {
      html.push(`<blockquote class="wiki-quote">${renderInline(line.trim().slice(2))}</blockquote>`);
      continue;
    }
    if (line.trim() === '') continue;
    html.push(`<p>${renderInline(line.trim())}</p>`);
  }

  flushList();
  flushTable();
  return html.join('\n');
}

const pages = [];
for (const entry of catalog.pages) {
  const docPath = resolve(root, entry.document);
  if (!existsSync(docPath)) {
    console.error(`build-knowledge FAIL: missing wiki page ${entry.document}`);
    process.exit(1);
  }
  for (const input of entry.inputs) {
    if (!existsSync(resolve(root, input))) {
      console.error(`build-knowledge FAIL: wiki page "${entry.id}" cites missing input ${input}`);
      process.exit(1);
    }
  }
  const markdown = readFileSync(docPath, 'utf8');
  writeFileSync(resolve(docsOutDir, `${entry.id}.md`), markdown, 'utf8');
  pages.push({
    ...entry,
    markdown,
    html: markdownToHtml(markdown),
    url: `${origin}/docs/${entry.id}.md`,
  });
}

// Include Mythical History in docs & llms.txt if present
const historyPath = resolve(root, '.smithers/wiki/mythical-history.md');
if (existsSync(historyPath)) {
  const historyMd = readFileSync(historyPath, 'utf8');
  writeFileSync(resolve(docsOutDir, 'mythical-history.md'), historyMd, 'utf8');
  pages.push({
    id: 'mythical-history',
    title: 'Mythical History',
    purpose: 'Chronological source-grounded history of Dub from verified jj commits and launch evidence.',
    kind: 'current',
    document: '.smithers/wiki/mythical-history.md',
    inputs: ['chromium/revision.json', 'docs/evidence/2026-11-23/README.md'],
    related: ['start-here', 'factory-and-trust'],
    markdown: historyMd,
    html: markdownToHtml(historyMd),
    url: `${origin}/docs/mythical-history.md`,
  });
}

// Copy key reference specs under site/docs/ for same-origin llms.txt discovery
const extraDocs = [
  { id: 'spec', title: 'Implementation Contract', src: 'docs/spec.md', purpose: 'Original Dub architecture contract, demos, and release gates.' },
  { id: 'seams', title: 'Chromium 157 Seam Census', src: 'docs/seams.md', purpose: 'Source-backed map of 32 pinned Chromium paths across eight browser seams.' },
  { id: 'acceptance', title: 'Acceptance Gates', src: 'docs/acceptance.md', purpose: 'Exact browser test inventory covering BRIDGE, NET, CLOCK, ACTOR, WEBMCP, PROFILE, and INSTALL.' },
  { id: 'contributing', title: 'Contributing and Trust Model', src: 'CONTRIBUTING.md', purpose: 'How external contributors work untrusted and how maintainer gates land changes.' },
];

const extraLinks = [];
for (const doc of extraDocs) {
  const srcPath = resolve(root, doc.src);
  if (!existsSync(srcPath)) continue;
  const content = readFileSync(srcPath, 'utf8');
  writeFileSync(resolve(docsOutDir, `${doc.id}.md`), content, 'utf8');
  extraLinks.push({ ...doc, url: `${origin}/docs/${doc.id}.md`, markdown: content });
}

// 1. Emit site/llms.txt (consumed natively by smithers.sh DocsSource)
const llmsLines = [
  '# Dub (DangerouslyUseBrowser)',
  '',
  '> Real Chromium 157.0.8082.0 fork exposing browser internals directly to agents through native C++20 N-API bindings and an incur MCP server. Built publicly on Smithers Cloud at https://smithers.sh/smithersai/dangerouslyusebrowser.',
  '',
  '## Engineering Wiki',
  '',
  ...pages.map(p => `- [${p.title}](${p.url}): ${p.purpose}`),
  '',
  '## Contracts and Specifications',
  '',
  ...extraLinks.map(d => `- [${d.title}](${d.url}): ${d.purpose}`),
  '',
  '## Factory Surfaces',
  '',
  `- [Smithers Cloud Coding Factory](https://smithers.sh/smithersai/dangerouslyusebrowser): Public issues, TODO stack, flows, and personalized Maintainer/Contributor/Viewer views`,
  `- [Lighthouse Backpressure Audit Report](${origin}/audit): Live Uphill audit scores across bridge safety, TypeScript, MCP security, fuzzing, and docs`,
  `- [Project Wiki UI](${origin}/wiki): Interactive searchable engineering wiki`,
  `- [Mythical History](${origin}/history): Verified chronological milestone ledger`,
  '',
];
writeFileSync(resolve(root, 'site/llms.txt'), `${llmsLines.join('\n')}`, 'utf8');

// 2. Emit site/llms-full.txt
const fullCorpus = [
  '# Dub (DangerouslyUseBrowser) - Full Technical Corpus',
  '',
  ...pages.flatMap(p => [`\n---\n<!-- ${p.document} -->\n`, p.markdown]),
  ...extraLinks.flatMap(d => [`\n---\n<!-- ${d.src} -->\n`, d.markdown]),
].join('\n');
writeFileSync(resolve(root, 'site/llms-full.txt'), fullCorpus, 'utf8');

// 3. Emit interactive site/wiki.html
const sidebarItems = pages
  .map(
    (p, idx) =>
      `<button class="wiki-nav-btn${idx === 0 ? ' active' : ''}" data-page="${esc(p.id)}" type="button">
        <span class="wiki-nav-title">${esc(p.title)}</span>
        <span class="wiki-nav-purpose">${esc(p.purpose)}</span>
      </button>`
  )
  .join('\n');

const articlePanels = pages
  .map(
    (p, idx) => `
    <article class="wiki-article${idx === 0 ? ' active' : ''}" id="page-${esc(p.id)}" data-page-id="${esc(p.id)}" data-search="${esc(`${p.title} ${p.purpose} ${p.inputs.join(' ')}`).toLowerCase()}">
      <div class="wiki-article-meta">
        <span class="wiki-pill">Source-cited</span>
        <code>${esc(p.document)}</code>
        <a class="wiki-raw-link" href="docs/${esc(p.id)}.md">Raw Markdown</a>
      </div>
      <div class="wiki-content">${p.html}</div>
      <div class="wiki-inputs">
        <h3>Pinned Source Inputs</h3>
        <div class="wiki-chip-row">
          ${p.inputs.map(inp => `<code class="wiki-chip">${esc(inp)}</code>`).join('')}
        </div>
      </div>
    </article>`
  )
  .join('\n');

const wikiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Engineering Wiki | Dub (DangerouslyUseBrowser)</title>
  <meta name="description" content="Source-cited Obsidian-compatible engineering wiki for Dub (Chromium 157 fork, C++20 N-API, MCP one-time auth, and Smithers Cloud factory).">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="styles.css">
  <style>
    .wiki-shell { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 28px; margin: 28px 0 56px; align-items: start; }
    .wiki-sidebar { position: sticky; top: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
    .wiki-search { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.04); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; color: var(--fg); font-size: 13px; margin-bottom: 12px; }
    .wiki-search:focus { outline: none; border-color: var(--accent, #f59e0b); }
    .wiki-nav { display: flex; flex-direction: column; gap: 6px; }
    .wiki-nav-btn { text-align: left; background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 10px 11px; cursor: pointer; color: var(--fg); transition: background 0.15s, border-color 0.15s; }
    .wiki-nav-btn:hover { background: rgba(255,255,255,0.04); }
    .wiki-nav-btn.active { background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.35); }
    .wiki-nav-title { display: block; font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
    .wiki-nav-purpose { display: block; font-size: 11.5px; color: var(--muted); line-height: 1.4; }
    .wiki-article { display: none; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 28px 32px; }
    .wiki-article.active { display: block; }
    .wiki-article-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-bottom: 14px; margin-bottom: 18px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .wiki-pill { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #34d399; padding: 2px 9px; border-radius: 999px; font-weight: 600; font-size: 11px; }
    .wiki-raw-link { margin-left: auto; color: var(--accent, #f59e0b); text-decoration: none; }
    .wiki-content h1 { margin-top: 0; font-size: 28px; }
    .wiki-content h2 { margin-top: 28px; font-size: 19px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
    .wiki-content p, .wiki-content li { color: var(--muted); line-height: 1.7; }
    .wiki-content strong { color: var(--fg); }
    .wiki-content a { color: var(--accent, #f59e0b); text-decoration: none; }
    .wiki-content a:hover { text-decoration: underline; }
    .wiki-pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; color: var(--fg); }
    .wiki-table-wrap { overflow-x: auto; margin: 16px 0; }
    .wiki-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .wiki-table th, .wiki-table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
    .wiki-table th { color: var(--fg); font-weight: 600; background: var(--code-bg); }
    .wiki-quote { border-left: 3px solid var(--accent); margin: 14px 0; padding: 6px 14px; color: var(--muted); background: var(--accent-soft); border-radius: 0 8px 8px 0; }
    .wiki-inputs { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); }
    .wiki-inputs h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
    .wiki-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .wiki-chip { font-family: var(--mono); font-size: 11.5px; padding: 3px 8px; border-radius: 6px; background: var(--code-bg); border: 1px solid var(--line); color: var(--muted); }
    @media (max-width: 860px) { .wiki-shell { grid-template-columns: 1fr; } .wiki-sidebar { position: static; } .wiki-article { padding: 20px; } }
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
        <a href="/wiki" aria-current="page">Wiki</a>
        <a href="/history">Mythical History</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://smithers.sh/smithersai/dangerouslyusebrowser">Smithers Cloud</a>
      </nav>
    </header>

    <main>
      <div class="eyebrow" style="margin-top:26px;">
        <span class="dot" aria-hidden="true"></span>
        <span>${pages.length} source-cited pages &middot; Obsidian-compatible &middot; Indexed at llms.txt</span>
      </div>
      <h1>Dub Engineering Wiki</h1>
      <p class="lead">
        Every page below is declared in <code>.smithers/coding-project.json</code>, bound to verified source inputs,
        and served to agents via <code>https://dangerouslyusebrowser.smithers.sh/llms.txt</code>.
      </p>

      <div class="wiki-shell">
        <aside class="wiki-sidebar">
          <input id="wiki-search" class="wiki-search" type="search" placeholder="Filter wiki pages..." aria-label="Filter wiki pages">
          <div class="wiki-nav" id="wiki-nav">
            ${sidebarItems}
          </div>
        </aside>
        <section class="wiki-main">
          ${articlePanels}
        </section>
      </div>
    </main>

    <footer>
      <span>Generated from <code>.smithers/wiki/</code> &middot; Read by <code>smithers.sh</code> via <code>llms.txt</code></span>
      <span><a href="https://smithers.sh/smithersai/dangerouslyusebrowser">smithers.sh/smithersai/dangerouslyusebrowser</a></span>
    </footer>
  </div>

  <script>
    (function () {
      const buttons = Array.from(document.querySelectorAll('.wiki-nav-btn'));
      const articles = Array.from(document.querySelectorAll('.wiki-article'));
      const search = document.getElementById('wiki-search');

      function selectPage(id, pushHash) {
        if (!articles.some(a => a.dataset.pageId === id)) return;
        buttons.forEach(b => b.classList.toggle('active', b.dataset.page === id));
        articles.forEach(a => a.classList.toggle('active', a.dataset.pageId === id));
        if (pushHash) history.replaceState(null, '', '#page-' + id);
      }

      buttons.forEach(btn => btn.addEventListener('click', () => selectPage(btn.dataset.page, true)));
      document.addEventListener('click', e => {
        const link = e.target.closest('[data-wiki-link]');
        if (!link) return;
        e.preventDefault();
        selectPage(link.getAttribute('data-wiki-link'), true);
      });

      if (search) {
        search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          buttons.forEach(btn => {
            const art = document.getElementById('page-' + btn.dataset.page);
            const hay = (btn.textContent + ' ' + (art ? art.dataset.search : '')).toLowerCase();
            btn.style.display = !q || hay.includes(q) ? '' : 'none';
          });
        });
      }

      const initial = location.hash.replace(/^#page-/, '');
      if (initial) selectPage(initial, false);
    })();
  </script>
</body>
</html>
`;

writeFileSync(resolve(root, 'site/wiki.html'), wikiHtml, 'utf8');

console.log(
  JSON.stringify({
    ok: true,
    pages: pages.length,
    extraDocs: extraLinks.length,
    outputs: ['site/llms.txt', 'site/llms-full.txt', 'site/wiki.html', 'site/docs/*.md'],
  })
);

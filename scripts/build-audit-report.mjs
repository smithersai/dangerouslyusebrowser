#!/usr/bin/env node
/**
 * Generate Dub's Google-Lighthouse-style Backpressure Audit Report UI (`site/audit.html`)
 * directly from Uphill's `.uphill/report.json` and `.smithers/` trust configuration.
 *
 * Never fabricates scores: every gauge, metric, opportunity, and item row is
 * rendered verbatim from `.uphill/report.json`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportJsonPath = resolve(root, '.uphill/report.json');

if (!existsSync(reportJsonPath) || process.argv.includes('--run')) {
  const uphillBin = existsSync(`${process.env.HOME}/.uphill/bin/uphill`)
    ? `${process.env.HOME}/.uphill/bin/uphill`
    : 'uphill';
  const res = spawnSync(uphillBin, ['--compact'], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0 && !existsSync(reportJsonPath)) {
    console.error('build-audit-report FAIL: unable to produce .uphill/report.json');
    process.exit(1);
  }
}

const report = JSON.parse(readFileSync(reportJsonPath, 'utf8'));
const factory = existsSync(resolve(root, '.smithers/factory.json'))
  ? JSON.parse(readFileSync(resolve(root, '.smithers/factory.json'), 'utf8'))
  : null;
const rev = JSON.parse(readFileSync(resolve(root, 'chromium/revision.json'), 'utf8'));

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tierOf(score) {
  if (score >= 90) return { key: 'pass', color: '#0cce6b', bg: 'rgba(12, 206, 107, 0.12)', label: 'Passing' };
  if (score >= 50) return { key: 'warn', color: '#ffa400', bg: 'rgba(255, 164, 0, 0.13)', label: 'Needs Work' };
  return { key: 'fail', color: '#ff4e42', bg: 'rgba(255, 78, 66, 0.14)', label: 'Failing' };
}

function formatMetricValue(metric, itemVal) {
  if (metric.kind === 'check') return itemVal ? 'PASS' : 'FAIL';
  if (typeof itemVal === 'number') {
    if (metric.unit === 'B') {
      if (itemVal >= 1_000_000) return `${(itemVal / 1_000_000).toFixed(2)} MB`;
      if (itemVal >= 1_000) return `${(itemVal / 1_000).toFixed(1)} kB`;
      return `${itemVal} B`;
    }
    return metric.unit ? `${itemVal} ${metric.unit}` : String(itemVal);
  }
  return String(itemVal ?? metric.value ?? '');
}

function formatTarget(metric, target) {
  if (metric.kind === 'check') return 'PASS';
  if (target === null || target === undefined) return 'Tracked';
  const op = metric.better === 'higher' ? '>= ' : '<= ';
  return `${op}${formatMetricValue(metric, target)}`;
}

const categories = report.categories ?? [];
const compositeScore =
  categories.length > 0
    ? Math.round(categories.reduce((acc, c) => acc + (c.score ?? 0), 0) / categories.length)
    : 0;
const compositeTier = tierOf(compositeScore);
const opportunities = report.opportunities ?? [];

const totalMetrics = categories.reduce((acc, c) => acc + (c.metrics?.length ?? 0), 0);
const passingMetrics = categories.reduce(
  (acc, c) => acc + (c.metrics ?? []).filter(m => (m.score ?? 0) >= 90).length,
  0
);

function gaugeSvg(score, size = 104) {
  const tier = tierOf(score);
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `
    <svg class="lh-gauge-svg" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="${r}" fill="${tier.bg}" stroke="var(--border)" stroke-width="7" />
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${tier.color}" stroke-width="7"
        stroke-linecap="round"
        stroke-dasharray="${circ.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(-90 50 50)" />
      <text x="50" y="55" text-anchor="middle" fill="${tier.color}" font-size="27" font-weight="700" font-family="var(--mono)">${score}</text>
    </svg>`;
}

const gaugeStripHtml = categories
  .map(cat => {
    const tier = tierOf(cat.score);
    return `
      <a class="lh-gauge-card" href="#cat-${esc(cat.name)}">
        ${gaugeSvg(cat.score, 98)}
        <span class="lh-gauge-title">${esc(cat.title)}</span>
        <span class="lh-gauge-pill lh-${tier.key}">${tier.label}</span>
      </a>`;
  })
  .join('\n');

const oppHtml =
  opportunities.length === 0
    ? `<div class="lh-all-clear">
         <span class="lh-dot lh-pass-dot"></span>
         <div>
           <strong>All Lighthouse backpressure targets are passing.</strong>
           <p>Every category clears its committed threshold with zero open opportunities.</p>
         </div>
       </div>`
    : `<div class="lh-opp-list">
        ${opportunities
          .map(
            opp => `
            <div class="lh-opp-row">
              <span class="lh-gain">+${esc(opp.gain)} pts</span>
              <div class="lh-opp-main">
                <strong>${esc(opp.category)} / ${esc(opp.metric)}</strong>
                <span>${esc(opp.item ?? `${opp.items} items`)}</span>
              </div>
              <div class="lh-opp-delta">
                <code>${esc(String(opp.value))}</code>
                <span aria-hidden="true">&rarr;</span>
                <code>${esc(String(opp.target))}</code>
              </div>
            </div>`
          )
          .join('\n')}
      </div>`;

const categorySectionsHtml = categories
  .map(cat => {
    const tier = tierOf(cat.score);
    const metricRows = (cat.metrics ?? [])
      .map(m => {
        const mTier = tierOf(m.score);
        const items = m.items && m.items.length > 0 ? m.items : [{ name: m.item ?? m.name, value: m.value, target: m.target, note: m.note }];
        const itemListHtml = items
          .map(it => {
            const valStr = formatMetricValue(m, it.value);
            const targetStr = formatTarget(m, it.target ?? m.target);
            const itemFailed = m.kind === 'check' ? !it.value : m.score < 90 && Boolean(it.note);
            return `
              <div class="lh-item-row ${itemFailed ? 'lh-item-miss' : ''}">
                <code class="lh-item-name">${esc(it.name)}</code>
                <span class="lh-item-val">${esc(valStr)}</span>
                <span class="lh-item-target">Target: ${esc(targetStr)}</span>
                ${it.note ? `<span class="lh-item-note">${esc(it.note)}</span>` : ''}
              </div>`;
          })
          .join('');
        return `
          <details class="lh-metric" data-tier="${mTier.key}" ${mTier.key !== 'pass' ? 'open' : ''}>
            <summary class="lh-metric-summary">
              <span class="lh-status-dot lh-dot-${mTier.key}" aria-label="${mTier.label}"></span>
              <span class="lh-metric-name">${esc(m.title)}</span>
              <span class="lh-metric-weight">w=${esc(m.weight ?? 1)}</span>
              <span class="lh-metric-score lh-${mTier.key}">${esc(m.score)}/100</span>
            </summary>
            <div class="lh-metric-body">
              <p class="lh-metric-desc">${esc(m.description)}</p>
              <div class="lh-items">${itemListHtml}</div>
            </div>
          </details>`;
      })
      .join('\n');

    return `
      <section class="lh-category" id="cat-${esc(cat.name)}">
        <div class="lh-cat-head">
          ${gaugeSvg(cat.score, 64)}
          <div>
            <h2>${esc(cat.title)}</h2>
            <p>${esc(cat.description)}</p>
          </div>
          <span class="lh-cat-badge lh-${tier.key}">${esc(cat.score)} / 100</span>
        </div>
        <div class="lh-metric-list">${metricRows}</div>
      </section>`;
  })
  .join('\n');

const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const protectedCount = factory?.github?.protectedPaths?.length ?? 0;
const maintainers = (factory?.github?.maintainers ?? ['roninjin10']).join(', ');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lighthouse Backpressure Audit | Dub (DangerouslyUseBrowser)</title>
  <meta name="description" content="Live Uphill Lighthouse-style backpressure audit report for Dub (smithersai/dangerouslyusebrowser).">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="styles.css">
  <script src="theme.js"></script>
  <style>
    .lh-banner { margin-top: 26px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 26px 28px; }
    .lh-top { display: flex; flex-wrap: wrap; gap: 20px; align-items: center; justify-content: space-between; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
    .lh-top h1 { margin: 4px 0 8px; font-size: 28px; }
    .lh-top p { margin: 0; color: var(--muted); max-width: 60ch; }
    .lh-composite { display: flex; align-items: center; gap: 14px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 14px; padding: 12px 18px; }
    .lh-composite-meta strong { display: block; font-size: 14px; color: var(--fg); }
    .lh-composite-meta span { display: block; font-size: 12px; color: var(--muted); }
    .lh-gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; padding-top: 24px; }
    .lh-gauge-card { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; text-decoration: none; padding: 16px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); transition: transform 0.15s, border-color 0.15s; }
    .lh-gauge-card:hover { transform: translateY(-2px); border-color: var(--subtle); }
    .lh-gauge-title { font-size: 13px; font-weight: 600; color: var(--fg); line-height: 1.3; }
    .lh-gauge-pill, .lh-cat-badge { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .lh-pass { color: #0cce6b; background: rgba(12, 206, 107, 0.13); border: 1px solid rgba(12, 206, 107, 0.35); }
    .lh-warn { color: #ffa400; background: rgba(255, 164, 0, 0.13); border: 1px solid rgba(255, 164, 0, 0.35); }
    .lh-fail { color: #ff4e42; background: rgba(255, 78, 66, 0.14); border: 1px solid rgba(255, 78, 66, 0.35); }
    .lh-legend { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; justify-content: center; margin-top: 18px; font-size: 12px; color: var(--muted); font-family: var(--mono); }
    .lh-legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .lh-swatch { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .lh-trust-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 24px 0; }
    .lh-trust-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
    .lh-trust-card label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
    .lh-trust-card strong { display: block; font-size: 14px; color: var(--fg); }
    .lh-trust-card span { display: block; font-size: 12px; color: var(--muted); margin-top: 3px; }
    .lh-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; margin: 22px 0; }
    .lh-panel h2 { margin: 0 0 12px; font-size: 18px; }
    .lh-all-clear { display: flex; gap: 12px; align-items: center; padding: 14px; border-radius: 10px; background: rgba(12, 206, 107, 0.09); border: 1px solid rgba(12, 206, 107, 0.3); }
    .lh-all-clear p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
    .lh-dot { width: 12px; height: 12px; border-radius: 999px; flex-shrink: 0; }
    .lh-pass-dot { background: #0cce6b; }
    .lh-opp-list { display: flex; flex-direction: column; gap: 8px; }
    .lh-opp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: rgba(255, 164, 0, 0.07); border: 1px solid rgba(255, 164, 0, 0.25); }
    .lh-gain { font-family: var(--mono); font-size: 12px; font-weight: 700; color: #ffa400; min-width: 64px; }
    .lh-opp-main { flex: 1; min-width: 200px; }
    .lh-opp-main strong { display: block; font-size: 13.5px; color: var(--fg); }
    .lh-opp-main span { font-size: 12px; color: var(--muted); }
    .lh-opp-delta { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 12px; }
    .lh-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 24px 0 12px; }
    .lh-filter-btn { background: var(--surface); border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
    .lh-filter-btn.active { color: var(--fg); border-color: var(--accent, #f59e0b); background: rgba(245, 158, 11, 0.12); }
    .lh-expand-btn { margin-left: auto; background: var(--surface); border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 6px 14px; font-size: 12px; font-family: var(--mono); cursor: pointer; }
    .lh-expand-btn:hover { color: var(--fg); border-color: var(--subtle); }
    .lh-repro-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); margin: 18px 0; font-size: 12.5px; }
    .lh-repro-bar code { font-size: 12px; }
    .lh-repro-links { margin-left: auto; display: flex; flex-wrap: wrap; gap: 12px; font-size: 12.5px; }
    .lh-category { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 22px 24px; margin-bottom: 18px; }
    .lh-cat-head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
    .lh-cat-head h2 { margin: 0 0 4px; font-size: 19px; }
    .lh-cat-head p { margin: 0; font-size: 13px; color: var(--muted); }
    .lh-cat-badge { margin-left: auto; font-size: 13px; padding: 5px 12px; }
    .lh-metric-list { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
    .lh-metric { border: 1px solid var(--line); border-radius: 10px; background: var(--bg); overflow: hidden; }
    .lh-metric-summary { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; list-style: none; font-size: 13.5px; }
    .lh-metric-summary::-webkit-details-marker { display: none; }
    .lh-status-dot { width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0; }
    .lh-dot-pass { background: #0cce6b; }
    .lh-dot-warn { background: #ffa400; }
    .lh-dot-fail { background: #ff4e42; }
    .lh-metric-name { font-weight: 600; color: var(--fg); }
    .lh-metric-weight { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-left: auto; }
    .lh-metric-score { font-family: var(--mono); font-size: 12px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
    .lh-metric-body { padding: 0 14px 14px 34px; border-top: 1px solid var(--line); }
    .lh-metric-desc { margin: 10px 0; font-size: 13px; color: var(--muted); }
    .lh-items { display: flex; flex-direction: column; gap: 6px; }
    .lh-item-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; background: var(--code-bg); font-size: 12.5px; }
    .lh-item-miss { background: rgba(255, 78, 66, 0.08); border: 1px solid rgba(255, 78, 66, 0.25); }
    .lh-item-name { color: var(--fg); }
    .lh-item-val { font-family: var(--mono); font-weight: 600; color: var(--fg); margin-left: auto; }
    .lh-item-target { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
    .lh-item-note { width: 100%; font-size: 12px; color: var(--muted); }
    .lh-item-miss .lh-item-note { color: var(--accent); }
    .lh-raw-receipt { margin-top: 28px; }
    .lh-raw-receipt summary { cursor: pointer; font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
    .lh-raw-receipt pre { margin-top: 10px; max-height: 360px; overflow: auto; background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px; padding: 14px; font-size: 11.5px; color: var(--fg); }
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
        <a href="/audit" aria-current="page">Lighthouse Audit</a>
        <a href="/wiki">Wiki</a>
        <a href="/history">Mythical History</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://smithers.sh/smithersai/dangerouslyusebrowser">Smithers Cloud</a>
        <button class="theme-btn" id="theme-toggle" type="button">Dark</button>
      </nav>
    </header>

    <main>
      <section class="lh-banner">
        <div class="lh-top">
          <div>
            <div class="eyebrow">
              <span class="dot" aria-hidden="true"></span>
              <span>Uphill Backpressure &middot; Chromium ${esc(rev.version)} &middot; Generated ${esc(generatedAt)}</span>
            </div>
            <h1>Dub Lighthouse Audit Report</h1>
            <p>
              Continuous, machine-verified backpressure across native C++20 bridge safety, TypeScript discipline,
              MCP one-time auth security, fuzzing depth, and public factory knowledge.
            </p>
          </div>
          <div class="lh-composite">
            ${gaugeSvg(compositeScore, 82)}
            <div class="lh-composite-meta">
              <strong>Composite Score</strong>
              <span>${passingMetrics} of ${totalMetrics} audits passing</span>
              <span class="lh-gauge-pill lh-${compositeTier.key}" style="display:inline-block;margin-top:4px;">${compositeTier.label}</span>
            </div>
          </div>
        </div>

        <div class="lh-gauges">
          ${gaugeStripHtml}
        </div>

        <div class="lh-legend" aria-label="Score legend">
          <span class="lh-legend-item"><span class="lh-swatch" style="background:#ff4e42"></span>0-49 Failing</span>
          <span class="lh-legend-item"><span class="lh-swatch" style="background:#ffa400"></span>50-89 Needs Work</span>
          <span class="lh-legend-item"><span class="lh-swatch" style="background:#0cce6b"></span>90-100 Passing</span>
        </div>
      </section>

      <section class="lh-trust-strip" aria-label="Trust and Object Store Posture">
        <div class="lh-trust-card">
          <label>Shared Object Store</label>
          <strong>build.smithers.sh</strong>
          <span>Incremental smthrs cache shared across controlled sandboxes</span>
        </div>
        <div class="lh-trust-card">
          <label>Untrusted Execution</label>
          <strong>Encouraged, Read-Only Cache</strong>
          <span>Fork PRs run checks freely without cache write or gate bypass</span>
        </div>
        <div class="lh-trust-card">
          <label>Protected Trust Roots</label>
          <strong>${protectedCount} Protected Paths</strong>
          <span>Maintainers: ${esc(maintainers)}</span>
        </div>
        <div class="lh-trust-card">
          <label>Sandbox MCP Auth</label>
          <strong>Single-Use One-Time Tokens</strong>
          <span>SHA-256 + timingSafeEqual + atomic replay rejection</span>
        </div>
      </section>

      <div class="lh-repro-bar" aria-label="Reproduce audit locally">
        <span>Reproduce locally:</span>
        <code id="lh-repro-cmd">uphill check &amp;&amp; uphill --compact --require-targets --require-baseline</code>
        <button class="lh-filter-btn" id="lh-copy-cmd" type="button">Copy</button>
        <div class="lh-repro-links">
          <a href="/docs/lighthouse-audit.md">Markdown receipt</a>
          <a href="/audit-summary.json">Summary JSON</a>
          <a href="https://github.com/smithersai/dangerouslyusebrowser/actions/workflows/uphill.yml">CI workflow</a>
        </div>
      </div>

      <section class="lh-panel">
        <h2>Opportunities (${opportunities.length})</h2>
        ${oppHtml}
      </section>

      <div class="lh-filters" role="group" aria-label="Filter audits">
        <button class="lh-filter-btn active" data-filter="all" type="button">All audits (${totalMetrics})</button>
        <button class="lh-filter-btn" data-filter="pass" type="button">Passing (${passingMetrics})</button>
        <button class="lh-filter-btn" data-filter="nonpass" type="button">Missed / Needs work (${totalMetrics - passingMetrics})</button>
        <button class="lh-expand-btn" id="lh-toggle-all" type="button" data-expanded="false">Expand all</button>
      </div>

      ${categorySectionsHtml}

      <details class="lh-raw-receipt">
        <summary>Inspect raw Uphill JSON receipt (.uphill/report.json)</summary>
        <pre>${esc(JSON.stringify(report, null, 2))}</pre>
      </details>
    </main>

    <footer>
      <span>Generated by <code>uphill</code> + <code>scripts/build-audit-report.mjs</code></span>
      <span><a href="https://smithers.sh/smithersai/dangerouslyusebrowser">smithers.sh/smithersai/dangerouslyusebrowser</a></span>
    </footer>
  </div>

  <script>
    (function () {
      const buttons = Array.from(document.querySelectorAll('.lh-filter-btn'));
      const metrics = Array.from(document.querySelectorAll('.lh-metric'));
      buttons.forEach(btn => {
        btn.addEventListener('click', () => {
          const filter = btn.dataset.filter;
          buttons.forEach(b => b.classList.toggle('active', b === btn));
          metrics.forEach(m => {
            const tier = m.dataset.tier;
            const show = filter === 'all' || (filter === 'pass' ? tier === 'pass' : tier !== 'pass');
            m.style.display = show ? '' : 'none';
          });
        });
      });

      const toggleAll = document.getElementById('lh-toggle-all');
      if (toggleAll) {
        toggleAll.addEventListener('click', () => {
          const next = toggleAll.dataset.expanded !== 'true';
          toggleAll.dataset.expanded = String(next);
          toggleAll.textContent = next ? 'Collapse all' : 'Expand all';
          metrics.forEach(m => { m.open = next; });
        });
      }

      const copyBtn = document.getElementById('lh-copy-cmd');
      const cmdEl = document.getElementById('lh-repro-cmd');
      if (copyBtn && cmdEl) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(cmdEl.textContent || '').then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
          });
        });
      }
    })();
  </script>
</body>
</html>
`;

writeFileSync(resolve(root, 'site/audit.html'), html, 'utf8');
writeFileSync(
  resolve(root, 'site/audit-summary.json'),
  JSON.stringify(
    {
      generatedAt,
      compositeScore,
      passingMetrics,
      totalMetrics,
      opportunities: opportunities.length,
      categories: categories.map(c => ({ name: c.name, title: c.title, score: c.score })),
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log(
  JSON.stringify({
    ok: true,
    compositeScore,
    categories: categories.map(c => ({ name: c.name, score: c.score })),
    opportunities: opportunities.length,
    output: 'site/audit.html',
  })
);

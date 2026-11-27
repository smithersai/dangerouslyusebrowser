import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Home } from '@smthrs/views';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Smithers home.json passes @smthrs/views schema and enforces personalized audience gating', () => {
  const raw = readFileSync(resolve(root, '.smithers/home.json'), 'utf8');
  const parsed = Home.read(raw);
  assert.equal(parsed._tag, 'Declared');
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.docs, 'https://dangerouslyusebrowser.smithers.sh/llms.txt');
  assert.equal(parsed.contributors, 'role');

  const viewerSections = Home.visible(parsed.sections, 'everyone');
  const contributorSections = Home.visible(parsed.sections, 'contributor');
  const maintainerSections = Home.visible(parsed.sections, 'maintainer');

  assert.deepEqual(
    viewerSections.map(s => s.audience),
    ['everyone']
  );
  assert.deepEqual(
    contributorSections.map(s => s.audience),
    ['contributor', 'everyone']
  );
  assert.deepEqual(
    maintainerSections.map(s => s.audience),
    ['maintainer', 'contributor', 'everyone']
  );
});

test('Smithers factory.json declares valid flows, maintainers, protectedPaths, and shared object store', () => {
  const factory = JSON.parse(readFileSync(resolve(root, '.smithers/factory.json'), 'utf8'));
  assert.ok(Array.isArray(factory.flows) && factory.flows.length >= 10);
  for (const flow of factory.flows) {
    assert.ok(existsSync(resolve(root, flow.path)), `Missing flow file: ${flow.path}`);
  }
  assert.ok(factory.github.maintainers.includes('roninjin10'));
  for (const protectedPath of ['.github', '.smithers', '.agents', 'chromium/patches', 'native', 'package.json']) {
    assert.ok(factory.github.protectedPaths.includes(protectedPath), `Missing protectedPath: ${protectedPath}`);
  }

  const workspace = readFileSync(resolve(root, '.smithers/WORKSPACE.ts'), 'utf8');
  assert.match(workspace, /https:\/\/build\.smithers\.sh/);
  assert.match(workspace, /SMITHERS_CACHE_READ_TOKEN/);
  assert.match(workspace, /SMITHERS_CACHE_WRITE_TOKEN/);
});

test('GitHub CI separates untrusted read-only PR runs from trusted main cache writes and auto-release', () => {
  const ciYml = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.equal(ciYml.includes('pull_request_target'), false, 'CI must never use pull_request_target');
  assert.match(ciYml, /untrusted-pr:/);
  assert.match(ciYml, /trusted-main:/);
  assert.match(ciYml, /SMITHERS_CACHE_READ_TOKEN/);
  assert.match(ciYml, /SMITHERS_CACHE_WRITE_TOKEN/);

  const untrustedBlock = ciYml.slice(ciYml.indexOf('untrusted-pr:'), ciYml.indexOf('trusted-main:'));
  assert.equal(
    untrustedBlock.includes('SMITHERS_CACHE_WRITE_TOKEN'),
    false,
    'Untrusted PR job must never receive SMITHERS_CACHE_WRITE_TOKEN'
  );

  const releaseYml = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(releaseYml, /publish-docs:/);
  assert.match(releaseYml, /release-package:/);
  assert.match(releaseYml, /dangerouslyusebrowser\.smithers\.sh/);
});

test('Knowledge graph, Mythical History, llms.txt, and Lighthouse audit UI are present and coherent', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, '.smithers/coding-project.json'), 'utf8'));
  assert.ok(catalog.pages.length >= 8);
  for (const page of catalog.pages) {
    assert.ok(existsSync(resolve(root, page.document)), `Missing wiki page: ${page.document}`);
    for (const input of page.inputs) {
      assert.ok(existsSync(resolve(root, input)), `Missing cited input ${input} for page ${page.id}`);
    }
  }

  const llmsTxt = readFileSync(resolve(root, 'site/llms.txt'), 'utf8');
  assert.match(llmsTxt, /https:\/\/dangerouslyusebrowser\.smithers\.sh\/docs\/start-here\.md/);
  assert.match(llmsTxt, /https:\/\/dangerouslyusebrowser\.smithers\.sh\/audit/);

  const auditHtml = readFileSync(resolve(root, 'site/audit.html'), 'utf8');
  assert.match(auditHtml, /Dub Lighthouse Audit Report/);
  assert.match(auditHtml, /build\.smithers\.sh/);

  const historyHtml = readFileSync(resolve(root, 'site/history.html'), 'utf8');
  assert.match(historyHtml, /Mythical History of Dub/);

  const mcpJson = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
  assert.equal(mcpJson.mcpServers['smithers-cloud'].url, 'https://smithers.sh/api/mcp');
});

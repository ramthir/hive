import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderHeaderChip, renderHeaderChips } from '../../static/components/page-header.js';
import { renderSearchTrigger } from '../../static/components/search-trigger.js';

test('the header search is one shared markup, not a copy per page', () => {
  const html = renderSearchTrigger();
  assert.match(html, /id="search-notes-btn"/);
  assert.match(html, /class="header-search"/);
  for (const page of ['notes/notes-page.js', 'tasks/tasks-page.js', 'specifications/specification-view.js', 'task-notes/task-view.js']) {
    const src = readFileSync(new URL(`../../static/${page}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('id="search-notes-btn"'), `${page} hardcodes the search button`);
    assert.ok(src.includes('renderSearchTrigger()'), `${page} does not use the shared search`);
  }
});

test('search sizing comes from tokens, not literals, and headers with chips use the compact width', () => {
  const css = readFileSync(new URL('../../static/hive.css', import.meta.url), 'utf8');
  const rule = css.match(/\.header-search \{[^}]*\}/)[0];
  const tokens = readFileSync(new URL('../../static/tokens.css', import.meta.url), 'utf8');
  for (const token of ['--search-width', '--search-height', '--search-bg', '--search-border', '--search-radius', '--search-font-size']) {
    assert.ok(rule.includes(`var(${token})`), `${token} unused`);
    assert.ok(tokens.includes(`${token}:`), `${token} undefined`);
  }
  assert.ok(tokens.includes('--search-width-compact:'));
  const headerSrc = readFileSync(new URL('../../static/app-header.js', import.meta.url), 'utf8');
  assert.match(headerSrc, /:host\(\[bottom\]\)\s*\{[^}]*--search-width:\s*var\(--search-width-compact/);
});

test('header chips share one helper and tone vocabulary across views', () => {
  assert.equal(renderHeaderChips([null, false, '']), '');
  const row = renderHeaderChips([
    { label: 'Active', tone: 'green', className: 'spec-status' },
    { label: 'CreatorIQ', icon: 'fa-solid fa-briefcase', tone: 'blue' },
    { label: 'APIM-66', icon: 'fa-solid fa-ticket', tone: 'blue', href: 'https://jira.example/browse/APIM-66', title: 'Open APIM-66 in Jira' },
  ]);
  assert.match(row, /^<div slot="subtitle" class="header-chips">/);
  assert.match(row, /<span class="header-chip spec-pill header-chip--green spec-pill--ok spec-status">Active<\/span>/);
  assert.match(row, /<i class="fa-solid fa-briefcase" aria-hidden="true"><\/i>CreatorIQ/);
  assert.match(row, /<a class="header-chip spec-pill header-chip--blue" title="Open APIM-66 in Jira" href="https:\/\/jira\.example\/browse\/APIM-66" target="_blank" rel="noopener noreferrer">/);
  assert.equal(renderHeaderChip({ label: 'a < b & "c"' }), '<span class="header-chip spec-pill">a &lt; b &amp; &quot;c&quot;</span>');
  for (const page of ['specifications/specification-view.js', 'task-notes/task-view.js']) {
    const src = readFileSync(new URL(`../../static/${page}`, import.meta.url), 'utf8');
    assert.ok(src.includes('renderHeaderChips('), `${page} does not use renderHeaderChips`);
  }
});

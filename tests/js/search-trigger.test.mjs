import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSearchTrigger } from '../../static/components/search-trigger.js';

test('the header search is one shared markup, not a copy per page', () => {
  const html = renderSearchTrigger();
  assert.match(html, /id="search-notes-btn"/);
  assert.match(html, /class="header-search"/);
  for (const page of ['notes/notes-page.js', 'tasks/tasks-page.js']) {
    const src = readFileSync(new URL(`../../static/${page}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('id="search-notes-btn"'), `${page} hardcodes the search button`);
    assert.ok(src.includes('renderSearchTrigger()'), `${page} does not use the shared search`);
  }
});

test('search sizing comes from tokens, not literals', () => {
  const css = readFileSync(new URL('../../static/hive.css', import.meta.url), 'utf8');
  const rule = css.match(/\.header-search \{[^}]*\}/)[0];
  for (const token of ['--search-width', '--search-height', '--search-bg', '--search-border', '--search-radius', '--search-font-size']) {
    assert.ok(rule.includes(`var(${token})`), `${token} unused`);
    assert.ok(readFileSync(new URL('../../static/tokens.css', import.meta.url), 'utf8').includes(`${token}:`), `${token} undefined`);
  }
});

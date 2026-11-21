import test from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';

// The browser modules import '/static/...'; point those at the repo for node.
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));
const { escapeWikilinkPipesInTableRows, configureMarkedWikilinks } = await import('../../static/notes/markdown.js');
const { DiagramPreviews } = await import('../../static/notes/diagrams.js');
const { marked } = createRequire(import.meta.url)('../../static/vendor/marked.min.js');

configureMarkedWikilinks(marked);
const html = (md) => marked.parse(md, { gfm: true });

test('a wikilink renders as a link with its target', () => {
  assert.match(html('see [[Plan]]'), /<a class="notes-wikilink" data-target="Plan" data-auto-label="true" href="#">Plan<\/a>/);
});

test('an aliased wikilink shows its label and keeps its target', () => {
  const out = html('[[plan|the plan]]');
  assert.match(out, /data-target="plan"/);
  assert.match(out, />the plan<\/a>/);
  assert.doesNotMatch(out, /data-auto-label/);
});

test('wikilink text is escaped', () => {
  assert.doesNotMatch(html('[[<img src=x onerror=1>]]'), /<img/);
});

test('the alias pipe stays inside one table cell', () => {
  const out = html('| a | b |\n|---|---|\n| [[plan|the plan]] | x |');
  assert.equal((out.match(/<td/g) || []).length, 2);
  assert.match(out, />the plan<\/a>/);
});

test('pipes are escaped only in table rows, not in prose or code fences', () => {
  assert.equal(escapeWikilinkPipesInTableRows('| [[a|b]] |'), '| [[a\\|b]] |');
  assert.equal(escapeWikilinkPipesInTableRows('text [[a|b]]'), 'text [[a|b]]');
  const fenced = '```\n| [[a|b]] |\n```';
  assert.equal(escapeWikilinkPipesInTableRows(fenced), fenced);
  assert.equal(escapeWikilinkPipesInTableRows('| [[a\\|b]] |'), '| [[a\\|b]] |');
});

test('a diagram is rendered once however many previews ask for it', async () => {
  let calls = 0;
  const diagrams = new DiagramPreviews(async () => { calls += 1; return { svg: '<svg/>' }; });
  await Promise.all([diagrams.fetch('A -> B'), diagrams.fetch('A -> B')]);
  await diagrams.fetch('A -> B');
  assert.equal(calls, 1);
  assert.match(diagrams.cache.get('A -> B'), /^data:image\/svg\+xml;charset=utf-8,/);
});

test('a failed diagram is remembered and not retried', async () => {
  let calls = 0;
  const diagrams = new DiagramPreviews(async () => {
    calls += 1;
    throw Object.assign(new Error('boom'), { status: 500 });
  });
  await diagrams.fetch('bad');
  await diagrams.fetch('bad');
  assert.equal(calls, 1);
  assert.equal(diagrams.errors.get('bad'), 'Could not render this diagram: boom');
});

test('a missing PlantUML setup (503) says so', async () => {
  const diagrams = new DiagramPreviews(async () => { throw Object.assign(new Error('no java'), { status: 503 }); });
  await diagrams.fetch('x');
  assert.equal(diagrams.errors.get('x'), 'PlantUML is not set up: no java');
});

test('the diagram cache keeps at most 100 entries, dropping the oldest', async () => {
  const diagrams = new DiagramPreviews(async () => ({ svg: '<svg/>' }));
  for (let i = 0; i < 101; i += 1) await diagrams.fetch(`d${i}`);
  assert.equal(diagrams.cache.size, 100);
  assert.ok(!diagrams.cache.has('d0'));
});

const { noteStats, updateSaveIndicator, updateStats } = await import('../../static/notes/status-bar.js');

test('word count, characters and reading time of a note', () => {
  assert.deepEqual(noteStats(''), { words: 0, chars: 0, readingMinutes: 0 });
  assert.deepEqual(noteStats(' one  two\nthree '), { words: 3, chars: 16, readingMinutes: 1 });
  assert.equal(noteStats('word '.repeat(76)).readingMinutes, 2);
  assert.deepEqual(noteStats(undefined), { words: 0, chars: 0, readingMinutes: 0 });
});

// A stand-in for the page: one element per selector the status bar touches.
const fakeRoot = (elements) => ({ querySelector: (selector) => elements[selector] ?? null });

test('the save button is enabled only for unsaved changes and shows a spinner while saving', () => {
  const button = { className: '', disabled: null, title: '', innerHTML: '' };
  const root = fakeRoot({ '#save-note-btn': button });
  updateSaveIndicator(root, 'dirty');
  assert.equal(button.disabled, false);
  assert.match(button.className, /\bdirty\b/);
  updateSaveIndicator(root, 'saving');
  assert.equal(button.disabled, true);
  assert.match(button.innerHTML, /fa-spin/);
  updateSaveIndicator(root, 'saved');
  assert.equal(button.disabled, true);
  assert.match(button.className, /\bclean\b/);
  assert.doesNotThrow(() => updateSaveIndicator(fakeRoot({}), 'dirty'));
});

test('the footer shows words, reading time and a character count', () => {
  const words = { textContent: '' };
  const reading = { textContent: '' };
  const stats = { title: '' };
  updateStats(fakeRoot({ '.stat-words .stat-value': words, '.stat-reading .stat-value': reading, '.notes-footer-stats': stats }), 'a b c');
  assert.equal(words.textContent, '3');
  assert.equal(reading.textContent, 1);
  assert.equal(stats.title, '5 characters');
});

import { readFileSync, existsSync } from 'node:fs';

test('the notes page links every notes stylesheet, in cascade order, and no stale notes.css', () => {
  const page = readFileSync(new URL('../../static/index.html', import.meta.url), 'utf8');
  const linked = [...page.matchAll(/href="\/static\/notes\/([\w-]+\.css)"/g)].map((m) => m[1]);
  assert.deepEqual(linked, ['layout.css', 'editor.css', 'preview.css', 'status-bar.css', 'menu.css', 'embeds.css']);
  for (const file of linked) assert.ok(existsSync(new URL(`../../static/notes/${file}`, import.meta.url)), `${file} is missing`);
  assert.ok(!existsSync(new URL('../../static/notes/notes.css', import.meta.url)));
});

const { markWords, parseDiff, renderDiff } = await import('../../static/notes/diff.js');

test('a version diff is numbered rows with changed words marked and gaps counted', () => {
  const out = renderDiff('--- a\n+++ b\n@@ -3,2 +3,2 @@\n keep\n-Ship to staging <b>\n+Ship to production <b>\n@@ -20 +20,2 @@\n-x\n+y\n+z');
  assert.match(out, /hive-diff-row del"><span class="no">4<\/span>/);
  assert.match(out, /hive-diff-row add"><span class="no">4<\/span>/);
  assert.match(out, /<mark>staging<\/mark>/);
  assert.match(out, /<mark>production<\/mark>/);
  assert.match(out, /&lt;b&gt;/);
  assert.match(out, /2 unchanged lines/); // before the first hunk
  assert.match(out, /15 unchanged lines/); // between the hunks
});

test('an empty diff says the text did not change', () => {
  assert.match(renderDiff('  \n'), /No changes to the text/);
});

test('parseDiff numbers old and new lines and skips the file header', () => {
  const { rows } = parseDiff('--- empty\n+++ c0ffee1\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.deepEqual(rows.map((r) => [r.type, r.no, r.text]), [['add', 1, 'one'], ['add', 2, 'two']]);
});

test('markWords leaves unrelated lines unmarked', () => {
  assert.deepEqual(markWords('abc', 'xyz'), ['abc', 'xyz']);
});

test('a rendered diagram carries a kebab menu with a dark and a light item', () => {
  const nodes = [];
  const doc = { createElement: () => ({ set innerHTML(html) { this.html = html; }, setAttribute() {}, className: '' }) };
  const diagrams = new DiagramPreviews(async () => ({}));
  const [, tools] = diagrams.content(doc, {}, 'data:x');
  assert.match(tools.html, /<app-dropdown-menu/);
  assert.match(tools.html, /data-download-theme="dark"/);
  assert.match(tools.html, /data-download-theme="light"/);
  assert.equal(nodes.length, 0);
});

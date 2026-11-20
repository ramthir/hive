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

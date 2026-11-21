import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));
const t = await import('../../static/tables/table-note.js');

const NOTE = `# Inventory

Some intro.

| Employee | Make | RAM |
| --- | --- | --- |
| [[Ann Lee]] | Lenovo | 16GB |
| [[ann-lee|Ann]]; [[Bo Kim]] | HP | — |
| Pipe \\| cell | Dell | 8GB |

Trailing text.
`;

test('parses the first table: columns, rows, and the text around it', () => {
  const p = t.parseMarkdownTableNote(NOTE);
  assert.equal(p.title, 'Inventory');
  assert.deepEqual(p.columns.map((c) => c.label), ['Employee', 'Make', 'RAM']);
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].col_0, '[[Ann Lee]]');
  assert.equal(p.rows[2].col_0, 'Pipe | cell');
  assert.equal(p.description, 'Some intro.');
  assert.deepEqual(p.suffixLines, ['', 'Trailing text.', '']);
});

test('a column of people or with links is a linked column', () => {
  const p = t.parseMarkdownTableNote(NOTE);
  assert.deepEqual(p.columns.map((c) => c.isWikilink), [true, false, false]);
});

test('serialising unchanged rows gives the note back byte for byte', () => {
  const p = t.parseMarkdownTableNote(NOTE);
  assert.equal(t.serializeMarkdownTableNote(p, p.rows), NOTE);
});

test('serialising escapes pipes outside wikilinks, keeps alias pipes, and fills empties with the dash the table uses', () => {
  const p = t.parseMarkdownTableNote(NOTE);
  const out = t.serializeMarkdownTableNote(p, [{ col_0: '[[a|b]]', col_1: 'x | y', col_2: '' }]);
  assert.match(out, /\| \[\[a\|b\]\] \| x \\\| y \| — \|/);
});

test('wikilink targets are titles or file names, with an optional label', () => {
  assert.deepEqual(t.extractWikilinkTargets('[[Ann Lee]]; [[ann-lee|Ann]]'), ['Ann Lee', 'ann-lee']);
  assert.equal(t.extractWikilinkTarget('plain'), '');
  const titles = new Map([['ann-lee', 'Ann Lee']]);
  assert.equal(t.resolveCellDisplay('[[ann-lee]]', titles).label, 'Ann Lee');
  assert.equal(t.resolveCellDisplay('[[ann-lee|Ann]]', titles).label, 'Ann');
  assert.equal(t.resolveCellDisplay('[[Nobody]]', titles).label, 'Nobody');
  assert.equal(t.resolveCellDisplay('', titles).label, '—');
});

test('filter matches raw text and the title a link resolves to; sort is natural and puts empties last', () => {
  const p = t.parseMarkdownTableNote(NOTE);
  assert.equal(t.filterTableRows(p.rows, p.columns, 'lenovo').length, 1);
  assert.equal(t.filterTableRows(p.rows, p.columns, 'full name', new Map([['Bo Kim', 'Full Name']])).length, 1);
  assert.equal(t.filterTableRows(p.rows, p.columns, 'zzz').length, 0);
  const asc = t.sortTableRows(p.rows, 'col_2', 'asc');
  assert.deepEqual(asc.map((r) => r.col_2), ['8GB', '16GB', '—']);
});

test('stat cards are read from a json table-config block', () => {
  const content = `${NOTE}\n\`\`\`json table-config\n{"stats":[{"label":"Laptops","op":"count"},{"label":"HP","op":"count_where","column":"Make","equals":"hp"},{"label":"No RAM","op":"count_empty","column":"RAM"}]}\n\`\`\`\n`;
  const cards = t.evaluateTableStats(t.parseTableStatsConfig(content), t.parseMarkdownTableNote(content));
  assert.deepEqual(cards.map((c) => c.value), ['3', '1', '1']);
});

test('a note without a table parses to no columns', () => {
  assert.deepEqual(t.parseMarkdownTableNote('# Hi\n\nNo table.').columns, []);
});

test('a note is a table note when one of its types is table', () => {
  assert.equal(t.isTableNote({ types: ['note', 'Table'] }), true);
  assert.equal(t.isTableNote({ types: ['note'] }), false);
  assert.equal(t.isTableNote({}), false);
});

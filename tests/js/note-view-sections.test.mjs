import test from 'node:test';
import assert from 'node:assert/strict';

const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));

const { renderSectionCard, renderSectionProse, renderChecklistBar } =
  await import('../../static/notes/note-view-sections.js');

test('section cards escape headings and keep rendered controls and prose', () => {
  const html = renderSectionCard({
    id: 'actions',
    title: 'Tasks & follow-up',
    headingHtml: '<span>1 of 3</span>',
    bodyHtml: renderSectionProse('<p>Follow up</p>'),
  });
  assert.match(html, /id="actions"/);
  assert.match(html, /Tasks &amp; follow-up<span>1 of 3<\/span>/);
  assert.match(html, /class="notes-preview-body spec-prose"><p>Follow up<\/p>/);
});

test('checklist bars show rounded progress and omit empty checklists', () => {
  const bar = renderChecklistBar({ done: 2, total: 3, className: 'progress', ariaLabel: '2 of 3 done' });
  assert.match(bar, /aria-label="2 of 3 done"/);
  assert.match(bar, /width:67%/);
  assert.equal(renderChecklistBar({ done: 0, total: 0, className: 'progress' }), '');
});

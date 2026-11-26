import test from 'node:test';
import assert from 'node:assert/strict';

const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));

const { renderSectionCard, renderSectionProse, renderChecklistBar, renderScopeSection } =
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

test('Scope uses one card for grouped Markdown and view-specific heading controls', () => {
  const html = renderScopeSection({
    id: 'task-s1',
    title: 'Scope',
    body: 'In scope:\n- First\nOut of scope:\n- Second',
    className: 'task-section task-section--checks',
    headingHtml: '<span>1 of 2</span>',
  }, (text) => `<p>${text}</p>`);
  assert.match(html, /id="task-s1" class="spec-section task-section task-section--checks spec-section--scope"/);
  assert.match(html, /Scope<span>1 of 2<\/span>/);
  assert.match(html, /spec-scope-group--in[\s\S]*<p>- First<\/p>/);
  assert.match(html, /spec-scope-group--out[\s\S]*<p>- Second<\/p>/);
});

test('Scope without group headings renders the original Markdown', () => {
  const body = '- A plain list';
  const html = renderScopeSection({ id: 'spec-scope', title: 'Scope', body }, (text) => {
    assert.equal(text, body);
    return '<ul><li>A plain list</li></ul>';
  });
  assert.match(html, /spec-prose"><ul><li>A plain list<\/li><\/ul>/);
  assert.equal(html.includes('spec-scope-group'), false);
});

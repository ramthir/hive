import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));
const t = await import('../../static/timelines/timeline-note.js');

const NOTE = `# Arrcus Timeline

Intro that belongs to no phase.

## July 2025 — Project Initialization: Requirements & Planning

Started project initialization by aligning requirements and scope. Key
tasks:

- Reviewed kickoff discussions.
- Analyzed [[Jira]] metadata for ANPN-14417.

## August 2025 — Initial Model Development

Built core model logic.

- Built **initial** model logic.
\`\`\`
## Not a heading
\`\`\`
`;

test('isTimelineNote reads the type list', () => {
  assert.equal(t.isTimelineNote({ types: ['Timeline'] }), true);
  assert.equal(t.isTimelineNote({ types: ['task'] }), false);
  assert.equal(t.isTimelineNote({}), false);
});

test('parseTimeline splits phases into label, title, summary and tasks', () => {
  const { phases } = t.parseTimeline(NOTE);
  assert.equal(phases.length, 2);
  assert.deepEqual(
    [phases[0].label, phases[0].title],
    ['July 2025', 'Project Initialization: Requirements & Planning'],
  );
  assert.equal(phases[0].summary, 'Started project initialization by aligning requirements and scope.'); // "Key tasks:" dropped
  assert.deepEqual(phases[0].tasks, ['Reviewed kickoff discussions.', 'Analyzed Jira metadata for ANPN-14417.']);
  assert.deepEqual(phases[1].tasks, ['Built initial model logic.']); // emphasis marks gone, fenced heading ignored
});

test('a heading without a dash has no label, and no headings means no phases', () => {
  assert.deepEqual(t.splitHeading('Kickoff'), { label: '', title: 'Kickoff' });
  assert.deepEqual(t.parseTimeline('# Only a title\n\ntext').phases, []);
});

test('readPagePath sends table and timeline notes to their own page', async () => {
  const { readPagePath } = await import('/static/notes/read-pages.js');
  assert.equal(readPagePath({ slug: 'plan', types: ['timeline'] }), '/timelines/plan');
  assert.equal(readPagePath({ slug: 'a b', types: ['Table'] }), '/tables/a%20b');
  assert.equal(readPagePath({ slug: 'spine-users', types: ['specification'] }), '/specifications/spine-users');
  assert.equal(readPagePath({ slug: 'spine-users', types: ['Spec'] }), '/specifications/spine-users');
  assert.equal(readPagePath({ slug: 'plan', types: ['task'] }), '');
  assert.equal(readPagePath({ types: ['table'] }), '');
});

test('phaseMarkdown writes a phase back as a heading, paragraph and bullets', () => {
  const md = t.phaseMarkdown({ label: 'July 2025', title: 'Kickoff', summary: 'Started.', tasks: ['One', 'Two'] });
  assert.equal(md, '## July 2025 — Kickoff\n\nStarted.\n\n- One\n- Two');
  assert.equal(t.phaseMarkdown({ label: '', title: 'Solo', summary: '', tasks: [] }), '## Solo');
});

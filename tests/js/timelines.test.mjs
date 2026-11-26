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
  assert.equal(readPagePath({ slug: 'plan', types: ['note'] }), '');
  assert.equal(readPagePath({ types: ['table'] }), '');
});

test('phaseMarkdown writes a phase back as a heading, paragraph and bullets', () => {
  const md = t.phaseMarkdown({ label: 'July 2025', title: 'Kickoff', summary: 'Started.', tasks: ['One', 'Two'] });
  assert.equal(md, '## July 2025 — Kickoff\n\nStarted.\n\n- One\n- Two');
  assert.equal(t.phaseMarkdown({ label: '', title: 'Solo', summary: '', tasks: [] }), '## Solo');
});

test('meeting minutes accept the type picker aliases and preserve existing read-page precedence', async () => {
  const { readPagePath } = await import('/static/notes/read-pages.js');
  for (const type of ['meeting_minutes', 'meeting-minutes', 'Meeting Minutes']) {
    assert.equal(readPagePath({ slug: 'kickoff', types: [type] }), '/meeting-minutes/kickoff');
  }
  assert.equal(readPagePath({ slug: 'kickoff', types: ['Meeting'] }), '/meetings/kickoff');
  assert.equal(readPagePath({ slug: 'kickoff', types: ['meeting', 'meeting-minutes'] }), '/meeting-minutes/kickoff');
  assert.equal(readPagePath({ slug: 'kickoff', types: ['meeting', 'task'] }), '/tasks/kickoff');
  assert.equal(readPagePath({ slug: 'kickoff', types: ['meeting_minutes', 'task'] }), '/tasks/kickoff');
});

test('meeting minutes preserve the lead, checklist, custom sections and fenced headings', async () => {
  const { parseMeetingMinutes } = await import('/static/meeting-minutes/meeting-minutes-note.js');
  const fence = '~~~~\n~~~\n## Example\n~~~\n~~~~';
  const note = ['# Kickoff', 'We discussed [[Alpha]].', '## Decisions', '- Launch Friday', '## Action Items ##',
    '- [ ] Sam to share the plan', '## Parking lot', fence, '## Parking lot', 'Second topic'].join('\n\n');
  assert.deepEqual(parseMeetingMinutes(note), {
    lead: 'We discussed [[Alpha]].',
    sections: [
      { name: 'Decisions', body: '- Launch Friday', tone: 'decisions' },
      { name: 'Action Items', body: '- [ ] Sam to share the plan', tone: 'actions' },
      { name: 'Parking lot', body: fence, tone: '' },
      { name: 'Parking lot', body: 'Second topic', tone: '' },
    ],
  });
  assert.deepEqual(parseMeetingMinutes('# Empty'), { lead: '', sections: [] });
});

test('meeting series sort dated minutes, retain undated links, and preserve rich sections', async () => {
  const { actionProgress, meetingArchive, meetingParticipants } =
    await import('/static/meeting-minutes/meeting-minutes-note.js');
  const rows = meetingArchive([
    '- [[Minutes — June 3, 2026]]',
    '- [[Undated]]',
    '- [[minutes-2026-11-18#Decisions|November minutes]]',
    '- [[Minutes — July 8, 2026]]',
  ].join('\n'));
  assert.deepEqual(rows.map(({ label }) => label),
    ['November minutes', 'Minutes — July 8, 2026', 'Minutes — June 3, 2026', 'Undated']);
  assert.equal(rows[0].destination, 'minutes-2026-11-18#Decisions');
  assert.deepEqual(meetingArchive('Notes about this list\n- [[Minutes]]'), []);
  assert.deepEqual(meetingParticipants('- [[Mira]] <mira@example.com>\n- [[Lee]]'), [
    { link: '[[Mira]]', email: 'mira@example.com' }, { link: '[[Lee]]', email: undefined },
  ]);
  assert.deepEqual(actionProgress('- [ ] Send invite\n- [x] Set date\n```md\n- [x] example\n```'),
    { done: 1, total: 2 });
});

test('minutes rows lead with the date, keep the rest of the title and say how far away it is', async () => {
  const { minutesRow } = await import('/static/meeting-minutes/meeting-minutes-note.js');
  const now = Date.UTC(2026, 10, 25, 15);
  assert.deepEqual(minutesRow({ label: 'Minutes — November 18, 2026', date: Date.UTC(2026, 10, 18) }, now),
    { title: 'Wednesday, November 18, 2026', subtitle: '', ago: '7 days ago' });
  assert.deepEqual(minutesRow({ label: 'Q4 planning - 2026-11-25', date: Date.UTC(2026, 10, 25) }, now),
    { title: 'Wednesday, November 25, 2026', subtitle: 'Q4 planning', ago: 'today' });
  assert.equal(minutesRow({ label: 'x', date: Date.UTC(2026, 10, 24) }, now).ago, 'yesterday');
  assert.equal(minutesRow({ label: 'x', date: Date.UTC(2026, 11, 2) }, now).ago, 'in 7 days');
  assert.equal(minutesRow({ label: 'x', date: Date.UTC(2026, 5, 3) }, now).ago, '6 months ago');
  assert.deepEqual(minutesRow({ label: 'Undated', date: null }, now), { title: 'Undated', subtitle: '', ago: '' });
});

test('meeting sections drop emoji from their names and still get their tone', async () => {
  const { parseMeetingMinutes, withoutEmoji } = await import('/static/meeting-minutes/meeting-minutes-note.js');
  const { sections } = parseMeetingMinutes('# T\n\n## ✅ Decisions\n- a\n\n## 📋 Action Items 🚀\n- [ ] b\n\n## 🎯\n');
  assert.deepEqual(sections.map(({ name, tone }) => [name, tone]),
    [['Decisions', 'decisions'], ['Action Items', 'actions'], ['🎯', '']]);
  assert.equal(withoutEmoji('1️⃣ Intro 👩‍💻'), 'Intro');
});

test('action items without a box count as not done and can be ticked', async () => {
  const { actionProgress, toggleAction } = await import('/static/meeting-minutes/meeting-minutes-note.js');
  assert.deepEqual(actionProgress('- [x] a\n- b\n1. c\n  - sub\n  - [x] nested'), { done: 1, total: 3 });
  const note = [
    '## Decisions', '- [ ] not an action', '## ✅ Action Items', '- [ ] a', '- b', '```', '- fenced', '```', '1. c', '- [x] d',
    '## Open Questions', '- q',
  ].join('\n');
  assert.equal(toggleAction(note, 1, true).split('\n')[4], '- [x] b');
  assert.equal(toggleAction(note, 2, true).split('\n')[8], '1. [x] c');
  assert.equal(toggleAction(note, 3, false).split('\n')[9], '- [ ] d');
  assert.equal(toggleAction(note, 0, true).split('\n')[1], '- [ ] not an action');
  assert.equal(toggleAction(note, 4, true), null);
  assert.equal(toggleAction('- [ ] x\n', 0, true), null);
});

test('a minutes breadcrumb is the full date when the title ends in one', async () => {
  const { shortMinutesDate } = await import('/static/meeting-minutes/meeting-minutes-note.js');
  assert.equal(shortMinutesDate('CIP Minutes — November 18, 2026'), 'Wednesday, November 18, 2026');
  assert.equal(shortMinutesDate('Weekly 2026-07-08'), 'Wednesday, July 8, 2026');
  assert.equal(shortMinutesDate('Kickoff Minutes'), '');
});

test('Note View routes choose the registration and leave the task board separate', async () => {
  const { noteViewForPath } = await import('../../static/notes/read-pages.js');
  assert.equal(noteViewForPath('/tasks'), undefined);
  assert.equal(noteViewForPath('/tasks/a-task').type, 'task');
  assert.equal(noteViewForPath('/meetings/weekly').type, 'meeting');
  assert.equal(noteViewForPath('/meeting-minutes/weekly').type, 'meeting_minutes');
});

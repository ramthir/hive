import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, noteHref, parseTags, renderCard, sortByPriority, taskPriority } from '../../static/tasks/card.js';

test('the board has the three Pandora columns in order', () => {
  assert.deepEqual(COLUMNS.map((c) => c.value), ['TODO', 'IN_PROGRESS', 'DONE']);
});

test('a card links to its note by slug', () => {
  assert.equal(noteHref({ slug: 'a b/c' }), '/notes/a%20b%2Fc');
  assert.match(renderCard({ slug: 'plan', title: 'Plan', tags: [] }), /href="\/notes\/plan"/);
});

test('a card escapes the title and tags', () => {
  const html = renderCard({ slug: 'x', title: '<img src=x onerror=1>', tags: ['"><b>'], updated: '2026-01-01' });
  assert.ok(!html.includes('<img') && !html.includes('<b>'));
  assert.ok(!html.includes('2026-01-01'), 'the card does not show the date, only its week chip');
});

test('todo and done tags are hidden because the column says it, other tags stay', () => {
  const html = renderCard({ slug: 'x', title: 'X', tags: ['todo', 'Done', 'work'] });
  assert.ok(html.includes('work'));
  assert.ok(!/>\s*todo</i.test(html) && !/>\s*done</i.test(html));
});

import { taskWeek, weekTitle, isDoneWeekChoice, doneWeekOptions, visibleTasks } from '../../static/tasks/card.js';

test('a card shows the week the server worked out for it', () => {
  assert.match(renderCard({ slug: 'x', title: 'X', tags: [], week_key: '2026-W47' }), />\s*W47</);
  assert.ok(!renderCard({ slug: 'x', title: 'X', tags: [] }).includes('board-chip--week'));
});

const CURRENT = '2026-W47'; // what GET /api/tasks/current-week returns

test('week titles and the Done filter choices', () => {
  assert.equal(weekTitle('2026-W07'), 'Week 07 2026');
  assert.ok(isDoneWeekChoice('2026-W47') && isDoneWeekChoice('all') && !isDoneWeekChoice('last') && !isDoneWeekChoice(null));
});

const done = (slug, week_key) => ({ slug, status: 'DONE', week_key });

test('the Done filter lists weeks newest first with counts, this week always, then All weeks', () => {
  const tasks = [
    done('a', '2026-W45'), done('b', '2026-W45'), done('c', '2026-W46'),
    { slug: 'open', status: 'TODO', week_key: '2020-W01' }, // open tasks never count
  ];
  const { options, selected } = doneWeekOptions(tasks, '2026-W47', CURRENT);
  assert.equal(selected, '2026-W47');
  assert.deepEqual(options.map((o) => [o.value, o.count]), [['2026-W47', 0], ['2026-W46', 1], ['2026-W45', 2], ['all', 3]]);
  assert.equal(options[0].title, 'Week 47 2026');
  // a shared link to a week with nothing in it keeps that week in the list
  assert.ok(doneWeekOptions(tasks, '2026-W30', CURRENT).options.some((o) => o.value === '2026-W30' && o.count === 0));
});

test('the Done filter hides finished tasks from other weeks and never open ones', () => {
  const tasks = [done('now', '2026-W47'), done('old', '2026-W40'), { slug: 'todo', status: 'TODO', week_key: '2019-W01' },
    { slug: 'doing', status: 'IN_PROGRESS' }];
  assert.deepEqual(visibleTasks(tasks, '2026-W47').map((t) => t.slug), ['now', 'todo', 'doing']);
  assert.deepEqual(visibleTasks(tasks, '2026-W40').map((t) => t.slug), ['old', 'todo', 'doing']);
  assert.equal(visibleTasks(tasks, 'all').length, 4);
});

test('a task week comes from week_key, and says whether it was recorded', () => {
  assert.deepEqual(taskWeek({ week_key: '2026-W40', week_stored: true }), { year: 2026, week: 40, stored: true });
  assert.deepEqual(taskWeek({ week_key: '2026-W47' }), { year: 2026, week: 47, stored: false });
  assert.equal(taskWeek({ week_key: null }), null);
  assert.match(renderCard({ slug: 'x', title: 'X', tags: [], week_key: '2026-W40', week_stored: true }), /Finished in week 40 of 2026/);
  assert.match(renderCard({ slug: 'x', title: 'X', tags: [], week_key: '2026-W40' }), /Last updated in week 40 of 2026/);
});

test('a task priority becomes a ranked chip, not a plain tag chip', () => {
  const html = renderCard({ slug: 'x', title: 'X', priority: 'must', tags: ['todo', 'work'] });
  assert.match(html, /board-chip--must[^>]*>(?:(?!<\/span>).)*Must</s);
  assert.ok(html.includes('work'));
  assert.match(renderCard({ slug: 'x', title: 'X', priority: 'important', tags: [] }), /board-chip--important[^>]*>(?:(?!<\/span>).)*Important</s);
  assert.match(renderCard({ slug: 'x', title: 'X', priority: 'nice-to-have', tags: [] }), /board-chip--good-to-have[^>]*>(?:(?!<\/span>).)*Nice to have</s);
  assert.ok(!renderCard({ slug: 'x', title: 'X', priority: null, tags: ['work'] }).includes('board-chip--priority'));
  assert.equal(taskPriority({ priority: 'bogus' }), null);
});

test('cards sort Must, Important, Nice to have, none (stable)', () => {
  const t = (slug, priority) => ({ slug, priority });
  const sorted = sortByPriority([t('a'), t('b', 'nice-to-have'), t('c', 'important'), t('d', 'must'), t('e'), t('f', 'must')]);
  assert.deepEqual(sorted.map((x) => x.slug), ['d', 'f', 'c', 'b', 'a', 'e']);
});

test('parseTags splits on commas, drops # and repeats', () => {
  assert.deepEqual(parseTags(' a, #b ,,a, c d '), ['a', 'b', 'c d']);
  assert.deepEqual(parseTags(''), []);
});


test('a card shows its ticket id, escaped, and nothing without one', () => {
  const html = renderCard({ slug: 'x', title: 'X', tags: [], ticket: 'PROJ-12' });
  assert.match(html, /board-chip--ticket[^>]*>.*PROJ-12/s);
  assert.ok(renderCard({ slug: 'x', title: 'X', tags: [], ticket: '<b>' }).includes('&lt;b&gt;'));
  assert.ok(!renderCard({ slug: 'x', title: 'X', tags: [] }).includes('board-chip--ticket'));
});

test('CreatorIQ ticket chips link directly to Jira in a new tab', () => {
  const task = { slug: 'x', title: 'X', ticket: 'APIM-66' };
  for (const project of ['CreatorIQ', '[[CreatorIQ]]']) {
    const html = renderCard({ ...task, project });
    assert.match(html, /<a class="board-chip board-chip--ticket board-chip--link" href="https:\/\/socialedge\.atlassian\.net\/browse\/APIM-66" target="_blank"/);
  }
  assert.doesNotMatch(renderCard({ ...task, project: 'Arrcus' }), /socialedge\.atlassian\.net/);
  assert.doesNotMatch(renderCard({ ...task, project: 'CreatorIQ', ticket: '../APIM-66' }), /socialedge\.atlassian\.net/);
  assert.doesNotMatch(renderCard({ ...task, project: 'CreatorIQ', ticket: '' }), /board-chip--ticket/);
});

test('cards show priority, ticket, project, week and remaining tags in order', () => {
  const html = renderCard({
    slug: 'x', title: 'X', priority: 'must', ticket: 'PROJ-12', project: '[[A & B]]',
    week_key: '2026-W47', tags: ['a & b', 'work'], total_tokens: 1234,
  });
  const chips = [...html.matchAll(/<\/i>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(chips, ['Must', 'PROJ-12', 'A &amp; B', 'W47', 'work']);
  assert.doesNotMatch(renderCard({ slug: 'x', title: 'X', project: ' ' }), /board-chip--project/);
});

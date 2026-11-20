import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, drawerChanges, editableTags, noteHref, parseTags, renderCard, sortByPriority, taskPriority } from '../../static/tasks/card.js';

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

import { isoWeek, taskWeek, currentWeekKey, weekTitle, isDoneWeekChoice, doneWeekOptions, visibleTasks } from '../../static/tasks/card.js';

test('isoWeek follows ISO 8601 across year boundaries', () => {
  assert.deepEqual(isoWeek('2026-11-20'), { year: 2026, week: 47 });
  assert.deepEqual(isoWeek('2026-01-01'), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek('2024-12-30'), { year: 2025, week: 1 }); // Monday of 2025's week 1
  assert.deepEqual(isoWeek('2021-01-03'), { year: 2020, week: 53 });
  assert.equal(isoWeek('nonsense'), null);
  assert.equal(isoWeek(null), null);
});

test('a card shows the week of its last update', () => {
  assert.match(renderCard({ slug: 'x', title: 'X', tags: [], updated: '2026-11-20' }), />\s*W47</);
  assert.ok(!renderCard({ slug: 'x', title: 'X', tags: [] }).includes('board-chip--week'));
});

const NOW = new Date(2026, 10, 20); // Friday 20 Nov 2026, ISO week 47

test('the current week key and titles', () => {
  assert.equal(currentWeekKey(NOW), '2026-W47');
  assert.equal(currentWeekKey(new Date(2026, 10, 16)), '2026-W47'); // Monday
  assert.equal(currentWeekKey(new Date(2026, 10, 22)), '2026-W47'); // Sunday
  assert.equal(currentWeekKey(new Date(2026, 10, 23)), '2026-W48');
  assert.equal(weekTitle('2026-W07'), 'Week 07 2026');
  assert.ok(isDoneWeekChoice('2026-W47') && isDoneWeekChoice('all') && !isDoneWeekChoice('last') && !isDoneWeekChoice(null));
});

const done = (slug, week, updated) => ({ slug, status: 'DONE', week, updated });

test('the Done filter lists weeks newest first with counts, this week always, then All weeks', () => {
  const tasks = [
    done('a', '2026-W45'), done('b', '2026-W45'), done('c', undefined, '2026-11-10'), // c: no key, week 46 by `updated`
    { slug: 'open', status: 'TODO', updated: '2020-01-01' }, // open tasks never count
  ];
  const { options, selected } = doneWeekOptions(tasks, '2026-W47', NOW);
  assert.equal(selected, '2026-W47');
  assert.deepEqual(options.map((o) => [o.value, o.count]), [['2026-W47', 0], ['2026-W46', 1], ['2026-W45', 2], ['all', 3]]);
  assert.equal(options[0].title, 'Week 47 2026');
  // a shared link to a week with nothing in it keeps that week in the list
  assert.ok(doneWeekOptions(tasks, '2026-W30', NOW).options.some((o) => o.value === '2026-W30' && o.count === 0));
});

test('the Done filter hides finished tasks from other weeks and never open ones', () => {
  const tasks = [done('now', '2026-W47'), done('old', '2026-W40', '2026-11-19'), { slug: 'todo', status: 'TODO', updated: '2019-01-01' },
    { slug: 'doing', status: 'IN_PROGRESS' }];
  assert.deepEqual(visibleTasks(tasks, '2026-W47').map((t) => t.slug), ['now', 'todo', 'doing']);
  assert.deepEqual(visibleTasks(tasks, '2026-W40').map((t) => t.slug), ['old', 'todo', 'doing']);
  assert.equal(visibleTasks(tasks, 'all').length, 4);
});

test('the week key wins over the updated day', () => {
  assert.deepEqual(taskWeek({ week: '2026-W40', updated: '2026-11-20' }), { year: 2026, week: 40, stored: true });
  assert.deepEqual(taskWeek({ week: 'garbage', updated: '2026-11-20' }), { year: 2026, week: 47 });
  const html = renderCard({ slug: 'x', title: 'X', tags: [], week: '2026-W40', updated: '2026-11-20' });
  assert.match(html, />\s*W40</);
  assert.match(html, /Finished in week 40 of 2026/);
});

test('a #must / #important / #nice-to-have tag becomes a ranked priority chip, not a plain tag chip', () => {
  const html = renderCard({ slug: 'x', title: 'X', tags: ['todo', 'must', 'work'] });
  assert.match(html, /board-chip--must[^>]*>(?:(?!<\/span>).)*Must</s);
  assert.ok(!/fa-tag[^>]*><\/i>must/.test(html) && html.includes('work'));
  assert.match(renderCard({ slug: 'x', title: 'X', tags: ['important'] }), /board-chip--important[^>]*>(?:(?!<\/span>).)*Important</s);
  assert.match(renderCard({ slug: 'x', title: 'X', tags: ['#nice-to-have'] }), /board-chip--good-to-have[^>]*>(?:(?!<\/span>).)*Nice to have</s);
  assert.ok(!renderCard({ slug: 'x', title: 'X', tags: ['work'] }).includes('board-chip--priority'));
});

test('the most urgent priority tag wins, and cards sort Must, Important, Nice to have, none (stable)', () => {
  assert.equal(taskPriority({ tags: ['important', 'must'] }).label, 'Must');
  const t = (slug, ...tags) => ({ slug, tags });
  const sorted = sortByPriority([t('a'), t('b', 'nice-to-have'), t('c', 'important'), t('d', 'must'), t('e'), t('f', 'must')]);
  assert.deepEqual(sorted.map((x) => x.slug), ['d', 'f', 'c', 'b', 'a', 'e']);
});

test('parseTags splits on commas, drops # and repeats', () => {
  assert.deepEqual(parseTags(' a, #b ,,a, c d '), ['a', 'b', 'c d']);
  assert.deepEqual(parseTags(''), []);
});

test('the drawer sends only what changed; priority swaps the priority tag, other tags come from the text', () => {
  const task = { title: 'T', status: 'TODO', tags: ['todo', 'must', 'work'] };
  assert.deepEqual(editableTags(task), ['todo', 'work']);
  assert.deepEqual(drawerChanges(task, { title: 'T', status: 'TODO', priority: 'must', tags: 'todo, work' }), {}, 'nothing changed');
  assert.deepEqual(drawerChanges(task, { title: ' New ', status: 'DONE', priority: 'must', tags: 'todo, work' }), { title: 'New', status: 'DONE' });
  assert.deepEqual(drawerChanges(task, { title: 'T', status: 'TODO', priority: 'important', tags: 'todo, work' }).tags, ['todo', 'work', 'important']);
  assert.deepEqual(drawerChanges(task, { title: 'T', status: 'TODO', priority: '', tags: 'todo, work' }).tags, ['todo', 'work']);
  assert.deepEqual(drawerChanges(task, { title: 'T', status: 'TODO', priority: 'must', tags: 'todo, work, #must, extra' }).tags, ['todo', 'work', 'extra', 'must']);
});

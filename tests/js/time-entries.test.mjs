import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteCall, listQuery, readState, savePlan, stateSearch, tableColumns, timeNoteOptions } from '../../static/time-entries/entries.js';
import { formatDay, formatDuration, today } from '../../static/time-entries/format.js';
import { canLogTime, dayHint, loggedLabel, loggedMinutes } from '../../static/time-entries/logged.js';
import { monthSparkline, summaryTiles } from '../../static/time-entries/summary.js';

test('durations read as hours and minutes', () => {
  assert.deepEqual([0, 5, 45, 60, 90, 120, 1440].map(formatDuration), ['0m', '5m', '45m', '1h', '1h 30m', '2h', '24h']);
  assert.equal(formatDuration(undefined), '0m');
});

test('an ISO day is shown as that calendar day, whatever the time zone', () => {
  assert.equal(formatDay('2026-11-20'), 'Fri, Nov 20, 2026');
  assert.equal(formatDay('nope'), 'nope');
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the picker keeps the server\'s order, with a type icon and headings once this week\'s notes are followed by others', () => {
  const notes = [
    { slug: 'd', title: 'Deploy', type: 'task', this_week: true },
    { slug: 's', title: 'Standup', type: 'meeting', this_week: true },
    { slug: 'a', title: 'Archive', type: 'task', this_week: false },
  ];
  assert.deepEqual(timeNoteOptions(notes), [
    { value: 'd', label: 'Deploy', icon: 'fa-solid fa-list-check', group: 'This week' },
    { value: 's', label: 'Standup', icon: 'fa-solid fa-calendar-check', group: 'This week' },
    { value: 'a', label: 'Archive', icon: 'fa-solid fa-list-check', group: 'Earlier' },
  ]);
});

test('the picker has no headings when all notes are on one side of the week', () => {
  for (const this_week of [true, false]) {
    const options = timeNoteOptions([{ slug: 'a', title: 'A', type: 'task', this_week }, { slug: 'b', title: 'B', type: 'task', this_week }]);
    assert.ok(options.every((o) => !('group' in o)));
  }
  assert.deepEqual(timeNoteOptions(undefined), []);
});

test('the summary tiles show the month with each kind\'s share', () => {
  const tiles = summaryTiles({ total_entries: 3, total_minutes: 200, task_minutes: 150, meeting_minutes: 50 });
  assert.deepEqual(tiles.map((t) => [t.key, t.value, t.sub]), [
    ['total', '3h 20m', '3 entries'], ['tasks', '2h 30m', '75% of logged time'], ['meetings', '50m', '25% of logged time']]);
  assert.equal(summaryTiles({ total_entries: 1 })[0].sub, '1 entry');
  assert.deepEqual(summaryTiles({}).map((t) => t.value), ['0m', '0m', '0m']);
  assert.equal(summaryTiles({})[1].sub, '0% of logged time');
});

test('the address holds the search and the page, counting pages from 1', () => {
  assert.deepEqual(readState(''), { q: '', page: 0 });
  assert.deepEqual(readState('?q=fix+project%3AAcme&page=3'), { q: 'fix project:Acme', page: 2 });
  assert.deepEqual(readState('?page=zero'), { q: '', page: 0 });
  assert.equal(stateSearch({ q: '', page: 0 }), '');
  assert.equal(stateSearch({ q: 'a b', page: 2 }), '?q=a+b&page=3');
  assert.equal(listQuery({ q: 'x', page: 2 }), 'page=2&page_size=10&q=x');
  assert.equal(listQuery({ q: '', page: 0 }, 5), 'page=0&page_size=5');
});

test('adding time adds the minutes to the day', () => {
  assert.deepEqual(savePlan(null, { slug: 'a b', day: '2026-11-20', minutes: '90' }), [
    { method: 'POST', path: '/notes/a%20b/time', body: { day: '2026-11-20', minutes: 90 } }]);
});

test('editing in place sets the minutes, or does nothing when they are the same', () => {
  const row = { slug: 'fix', day: '2026-11-20', minutes: 60 };
  assert.deepEqual(savePlan(row, { slug: 'fix', day: '2026-11-20', minutes: '90' }), [
    { method: 'PUT', path: '/notes/fix/time/2026-11-20', body: { minutes: 90 } }]);
  assert.deepEqual(savePlan(row, { slug: 'fix', day: '2026-11-20', minutes: '60' }), []);
});

test('moving a row to another note or day is one call, so one commit', () => {
  const row = { slug: 'fix', day: '2026-11-20', minutes: 60 };
  for (const target of [{ slug: 'other', day: '2026-11-20' }, { slug: 'fix', day: '2026-11-21' }]) {
    assert.deepEqual(savePlan(row, { ...target, minutes: '60' }), [
      { method: 'POST', path: '/notes/fix/time/2026-11-20/move', body: { slug: target.slug, day: target.day, minutes: 60 } }]);
  }
  assert.deepEqual(deleteCall(row), { method: 'DELETE', path: '/notes/fix/time/2026-11-20' });
});

test('input the server would refuse is refused before any call', () => {
  const ok = { slug: 'fix', day: '2026-11-20', minutes: '30' };
  assert.throws(() => savePlan(null, { ...ok, slug: '' }), /task or meeting/);
  assert.throws(() => savePlan(null, { ...ok, day: '' }), /date/);
  for (const minutes of ['0', '1441', '1.5', 'abc', '']) assert.throws(() => savePlan(null, { ...ok, minutes }), /duration/);
});

test('table cells escape what comes from notes', () => {
  const esc = (v) => String(v).replace(/</g, '&lt;');
  const [day, title, project, minutes] = tableColumns(esc);
  assert.equal(day.render('2026-11-20'), 'Fri, Nov 20, 2026');
  const cell = title.render('<b>x</b>', { type: 'meeting', slug: 'a/b' });
  assert.match(cell, /&lt;b>x&lt;\/b>/);
  assert.match(cell, /fa-calendar-check/);
  assert.match(cell, /href="\/notes\/a%2Fb"/);
  assert.doesNotMatch(cell, /<b>/);
  assert.match(project.render(''), /—/);
  assert.equal(project.render('Acme'), 'Acme');
  assert.equal(minutes.render(90), '1h 30m');
});

test('only a saved task or meeting note can have time logged', () => {
  assert.ok(canLogTime({ slug: 'a', takes_time: true }));
  assert.ok(!canLogTime({ slug: 'a', takes_time: false }));
  assert.ok(!canLogTime({ slug: 'a' }));
  assert.ok(!canLogTime({ slug: null, takes_time: true }));
  assert.ok(!canLogTime(null));
});

test('the footer says how much time a note has, and nothing when there is none', () => {
  assert.equal(loggedMinutes({ '2026-11-20': 90, '2026-11-21': 45 }), 135);
  assert.equal(loggedLabel({ '2026-11-20': 90, '2026-11-21': 45 }), '2h 15m logged');
  assert.equal(loggedLabel({}), '');
  assert.equal(loggedLabel(undefined), '');
});

test('the dialog tells what the chosen day already holds', () => {
  assert.equal(dayHint({ '2026-11-20': 90 }, '2026-11-20'), '1h 30m already logged on Fri, Nov 20, 2026. This adds to it.');
  assert.equal(dayHint({}, '2026-11-20'), 'Nothing logged on Fri, Nov 20, 2026 yet.');
});

test('the total card carries the month and day progress against the 160h and 8h targets', () => {
  const [total, tasks, meetings] = summaryTiles({ total_minutes: 4800, today_minutes: 120, total_entries: 2 });
  assert.equal(total.title, 'Total Logged');
  assert.equal(total.progress, 50);
  assert.equal(total.dailyProgress, 25);
  assert.equal(total.dailyTooltip, '2h of 8h logged today');
  assert.equal(summaryTiles({ total_minutes: 99999, today_minutes: 99999 })[0].progress, 100);
  assert.equal(tasks.progress, undefined);
  assert.equal(meetings.sparkline, undefined);
});

test('the sparkline has a value per day of the server\'s month and tooltip rows only for days with time', () => {
  const meta = {
    month: '2026-02',
    days: [{ day: '2026-02-03', minutes: 105, items: [
      { title: 'Fix login', project: 'Acme', minutes: 90 }, { title: 'Standup', project: '', minutes: 15 }] }],
  };
  const spark = monthSparkline(meta);
  assert.equal(spark.start, '2026-02-01');
  assert.equal(spark.values.length, 28);
  assert.equal(spark.values[2], 105);
  assert.equal(spark.values.reduce((a, b) => a + b, 0), 105);
  assert.equal(spark.details[0], null);
  assert.deepEqual(spark.details[2], [
    { label: 'Fix login', value: '1h 30m', note: '(Acme)' }, { label: 'Standup', value: '15m' }, { label: 'Total', value: '1h 45m' }]);
  assert.equal(monthSparkline({ month: '2024-02' }).values.length, 29);
  assert.equal(monthSparkline({}), null);
  assert.equal(summaryTiles({ month: '2026-02', days: meta.days })[0].sparkline.values[2], 105);
});

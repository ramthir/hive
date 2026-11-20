import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteCall, formatDay, formatDuration, listQuery, readState, savePlan, stateSearch, summaryTiles, tableColumns, timeNoteOptions, today,
} from '../../static/time-entries/entries.js';

test('durations read as hours and minutes', () => {
  assert.deepEqual([0, 5, 45, 60, 90, 120, 1440].map(formatDuration), ['0m', '5m', '45m', '1h', '1h 30m', '2h', '24h']);
  assert.equal(formatDuration(undefined), '0m');
});

test('an ISO day is shown as that calendar day, whatever the time zone', () => {
  assert.equal(formatDay('2026-11-20'), 'Fri, Nov 20, 2026');
  assert.equal(formatDay('nope'), 'nope');
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('only tasks and meetings can take time, listed by title', () => {
  const notes = [
    { slug: 'z', title: 'Zeta', types: ['task'] },
    { slug: 'i', title: 'Idea', types: ['idea'] },
    { slug: 'a', title: 'alpha', types: ['contact', 'Meeting'] },
    { slug: 'n', title: 'None' },
  ];
  assert.deepEqual(timeNoteOptions(notes), [{ value: 'a', label: 'alpha' }, { value: 'z', label: 'Zeta' }]);
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

test('moving a row to another note or day adds there and removes the old one', () => {
  const row = { slug: 'fix', day: '2026-11-20', minutes: 60 };
  for (const target of [{ slug: 'other', day: '2026-11-20' }, { slug: 'fix', day: '2026-11-21' }]) {
    assert.deepEqual(savePlan(row, { ...target, minutes: '60' }), [
      { method: 'POST', path: `/notes/${target.slug}/time`, body: { day: target.day, minutes: 60 } },
      { method: 'DELETE', path: '/notes/fix/time/2026-11-20' }]);
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

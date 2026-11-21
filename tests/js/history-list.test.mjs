import test from 'node:test';
import assert from 'node:assert/strict';
import { changeBar, changeChip, dayLabel, filterTabs, matchesFilter, renderVersionList, renderVersionRow } from '../../static/notes/history-list.js';

const now = new Date(2026, 10, 21, 15, 0, 0);
const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();

test('days read as Today, Yesterday or a date', () => {
  assert.equal(dayLabel(at(2026, 10, 21, 9), now), 'Today');
  assert.equal(dayLabel(at(2026, 10, 20), now), 'Yesterday');
  assert.equal(dayLabel(at(2026, 10, 17), now), 'Tue, Nov 17');
  assert.match(dayLabel(at(2025, 10, 17), now), /2025/);
});

test('the change chip shows lines added and removed, and nothing for a rename', () => {
  assert.match(changeChip({ added: 12, removed: 3 }), /\+12.*−3/);
  assert.equal(changeChip({ added: 0, removed: 0 }), '');
  assert.equal(changeChip({}), '');
});

test('a later page continues the day of the page before', () => {
  const first = { sha: 'a1', message: 'x', author: 'A', committed_at: at(2026, 10, 21, 10) };
  const second = { sha: 'b2', message: 'y', author: 'A', committed_at: at(2026, 10, 21, 9) };
  assert.doesNotMatch(renderVersionList([second], now, first), /hive-version-day/);
  assert.match(renderVersionList([second], now), /hive-version-day/);
});

test('the list gets one heading per day and escapes messages', () => {
  const html = renderVersionList([
    { sha: 'a1', message: '<b>x</b>', author: 'A', committed_at: at(2026, 10, 21, 10), added: 1, removed: 0 },
    { sha: 'b2', message: 'two', author: 'A', committed_at: at(2026, 10, 21, 9), added: 2, removed: 1 },
    { sha: 'c3', message: 'old', author: 'A', committed_at: at(2026, 10, 20), added: 0, removed: 0 },
  ], now);
  assert.equal((html.match(/hive-version-day/g) || []).length, 2);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal((html.match(/data-sha=/g) || []).length, 3);
});

test('a version shows under every filter its kinds match', () => {
  const both = { kind: 'text', kinds: ['text', 'properties'] };
  assert.deepEqual(['all', 'text', 'properties', 'time', 'restores'].map((id) => matchesFilter(both, id)), [true, true, true, false, false]);
  assert.equal(matchesFilter({ kind: 'restore' }, 'restores'), true);
  assert.equal(matchesFilter({}, 'text'), false);
});

test('the change bar has at most five squares and keeps both colours when both exist', () => {
  const squares = (v) => [(changeBar(v).match(/class="add"/g) || []).length, (changeBar(v).match(/class="del"/g) || []).length];
  assert.deepEqual(squares({ added: 100, removed: 1 }), [4, 1]);
  assert.deepEqual(squares({ added: 2, removed: 0 }), [2, 0]);
  assert.deepEqual(squares({ added: 1, removed: 50 }), [1, 4]);
  assert.equal(changeBar({ added: 0, removed: 0 }), '');
});

test('a row says what changed, with the git message as its tooltip', () => {
  const html = renderVersionRow({ sha: 'c0ffee1aa', kind: 'properties', kinds: ['properties'], summary: 'Moved to Done', detail: '', message: 'doc: update <T>', author: 'A', committed_at: at(2026, 10, 21, 9) });
  assert.match(html, />Moved to Done</);
  assert.match(html, /title="doc: update &lt;T&gt;"/);
  assert.match(html, /kind-properties/);
  assert.match(html, /<code>c0ffee1<\/code>/);
  assert.match(renderVersionRow({ sha: 'x', message: 'doc: add X', author: 'A', committed_at: at(2026, 10, 21, 9) }), />doc: add X</);
});

const { diffCounts, positionLabel, renderProperties, renderVersionDetail, renderVersionPending, restoreDetails } = await import('../../static/notes/history-detail.js');

test('property changes show old to new chips and keep bookkeeping dim', () => {
  assert.equal(renderProperties([]), '');
  const html = renderProperties([
    { key: 'status', old: 'IN_PROGRESS', new: 'DONE', minor: false },
    { key: 'week', old: null, new: '2026-W47', minor: false },
    { key: 'ticket', old: 'ABC-1', new: null, minor: false },
    { key: 'updated', old: '2026-11-20', new: '2026-11-21', minor: true },
  ]);
  assert.match(html, /chip old">IN_PROGRESS.*chip new">DONE/s);
  assert.doesNotMatch(html.split('week')[1].split('ticket')[0], /chip old/); // a new key has no "old" chip
  assert.match(html, /removed/);
  assert.match(html, /hive-prop-row minor.*bookkeeping/s);
});

test('the version view has the summary, the compare toggle, the properties and the text', () => {
  const version = { sha: 'c0ffee1aa', kind: 'properties', summary: 'Moved to Done', detail: '', message: 'doc: update A', author: 'R', committed_at: at(2026, 10, 21, 9) };
  const info = { diff: '--- a\n+++ b\n@@ -1 +1 @@\n-one\n+two\n', properties: [{ key: 'status', old: 'TODO', new: 'DONE', minor: false }], index: 3, total: 47 };
  const html = renderVersionDetail(version, 'current', info);
  assert.match(html, /Moved to Done/);
  assert.match(html, /class="hive-vd-compare" size="drawer" aria-label="Compare with" data-active="current"/);
  assert.match(html, /\+1.*−1.*1 property/s);
  assert.match(html, /Properties/);
  assert.match(html, /hive-diff-row add/);
  assert.equal(positionLabel(info), '3 of 47');
  assert.deepEqual(diffCounts(info.diff), { added: 1, removed: 1 });
});

test('the restore confirmation mentions a rename only when the title changes', () => {
  assert.equal(restoreDetails({ version_title: 'A', current_title: 'A' }).length, 2);
  assert.match(restoreDetails({ version_title: 'Fresh Idea', current_title: 'Beta' })[1], /Fresh Idea/);
});

test('the filters become the tab bar\'s tabs, in order', () => {
  assert.deepEqual(Object.entries(filterTabs()).map(([id, tab]) => [id, tab.label]),
    [['all', 'All'], ['text', 'Text'], ['properties', 'Properties'], ['time', 'Time'], ['restores', 'Restores']]);
});

test('a version that deleted the note is a disabled row with a trash icon', () => {
  const html = renderVersionRow({ sha: 'd1', kind: 'deleted', kinds: ['deleted'], summary: 'Deleted the note', deleted: true, message: 'docs: remove', author: 'A', committed_at: at(2026, 10, 21, 9) });
  assert.match(html, /<button[^>]* disabled /);
  assert.match(html, /fa-trash/);
  assert.doesNotMatch(renderVersionRow({ sha: 'x', message: 'm', author: 'A', committed_at: at(2026, 10, 21, 9) }), /disabled/);
});

test('the pending version view shows the summary and a placeholder', () => {
  const html = renderVersionPending({ sha: 'c0ffee1aa', kind: 'text', summary: 'Edited text', detail: 'Plan', message: 'doc: update', author: 'R', committed_at: at(2026, 10, 21, 9) });
  assert.match(html, /Edited text/);
  assert.match(html, /hive-vd-skeleton/);
});

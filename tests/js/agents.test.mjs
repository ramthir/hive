import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { axisLabels, compact, niceMax, pagerState, renderTrend, renderUsage, sessionColumns, sessionRows, sessionsQuery, shortSession } from '../../static/agents/usage-render.js';
import { sessionResumeCommand } from '../../static/agents/session-resume.js';
import { TABS, tabBarTabs, tabForPath } from '../../static/dashboard/tabs.js';

const tokens = (input, cached, output) => ({ input, cached_input: cached, cache_write: 0, output, total: input + output });
const provider = (total, extra = {}) => ({ status: 'available', tokens: tokens(total, total / 2, 10), sessions: 3, models: ['m1', 'm2'], model_tokens: [], daily: [], ...extra });
const view = (extra = {}) => ({
  status: 'ok', reason: null, month: '2026-11', generated_at: '2026-11-21T08:00:00+00:00', covers: { from: '2026-11-01', to: '2026-11-21' },
  providers: { claude: provider(1500), codex: { status: 'no_usage', tokens: null, sessions: 0, models: [], daily: [] }, antigravity: { status: 'no_usage', tokens: null, sessions: 0, models: [], daily: [] } },
  ...extra,
});

test('there is a card for each provider, and one without usage shows zero sessions', () => {
  const html = renderUsage(view());
  assert.deepEqual([...html.matchAll(/data-provider="(\w+)"/g)].map((m) => m[1]), ['claude', 'codex', 'antigravity']);
  assert.match(html, /3 sessions/);
  assert.match(html, /0 sessions/);
});

test('the page says nothing about quota, tasks or the old product names', () => {
  const html = renderUsage(view());
  assert.doesNotMatch(html, /quota|donut|Na'vi|navi|Pandora/i);
});

test('a stale or unavailable report shows a banner with the reason', () => {
  assert.match(renderUsage(view({ status: 'stale', reason: 'The report is older than 45 minutes.' })), /class="banner stale"[^>]*>.*older than 45 minutes/s);
  const down = renderUsage({ status: 'unavailable', reason: 'ccusage was not found', providers: { claude: { status: 'unavailable', reason: 'ccusage was not found' } } });
  assert.match(down, /banner unavailable/);
  assert.match(down, /Unavailable: ccusage was not found/);
  assert.equal(renderUsage(view()).includes('class="banner'), false);
});

test('the reason is escaped', () => {
  assert.doesNotMatch(renderUsage(view({ status: 'stale', reason: '<img src=x onerror=1>' })), /<img/);
});

test('loading shows placeholders for the cards, the chart and the table', () => {
  const html = renderUsage(null);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /id="sessions-table"/);
  assert.equal((html.match(/class="card"/g) || []).length, 3);
});

test('the trend stacks the providers per day and is readable as text', () => {
  const daily = (date, total) => [{ date, ...tokens(total, 0, 0) }];
  const html = renderTrend(view({ providers: { claude: provider(10, { daily: daily('2026-11-20', 600) }), codex: provider(4, { daily: daily('2026-11-20', 400) }) } }));
  assert.match(html, /Nov 20: 1,000 tokens \(Claude 600, Codex 400\)/);
  assert.equal((html.match(/class="bar"/g) || []).length, 30); // every day of November, so the axis does not change length
});

test('the axis tops at a round number', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(1300), 2000);
  assert.equal(niceMax(4000), 5000);
  assert.deepEqual(axisLabels(2e9), ['2B', '1B', '0']);
  assert.deepEqual(axisLabels(500), ['500', '250', '0']);
});

test('numbers are compact and session ids short', () => {
  assert.equal(compact(1234567), '1.23M');
  assert.equal(shortSession('2026/11/21/rollout-2026-11-21T02-37-07-0199abcd-1234-5678-9abc-def012345678'), '0199abcd');
  assert.equal(shortSession('0123456789abcdef'), '01234567');
});

test('resume commands exist for Claude and Codex and only for safe ids', () => {
  assert.equal(sessionResumeCommand('claude', 'abc-123'), 'claude --resume abc-123');
  assert.equal(sessionResumeCommand('codex', '2026/11/21/rollout-2026-11-21T02-37-07-0199abcd-1234-5678-9abc-def012345678'), 'codex resume 0199abcd-1234-5678-9abc-def012345678');
  assert.equal(sessionResumeCommand('claude', 'a; rm -rf /'), null);
  assert.equal(sessionResumeCommand('unknown', 'abc'), null);
});

test('session rows are what the server sent, escaped, and the table is server sorted', () => {
  const rows = sessionRows([{ provider: 'claude', session: 'x"><b>', models: ['m'], tokens: tokens(5, 2, 1), last_activity: '2026-11-20T10:00:00Z' }]);
  assert.deepEqual(rows[0], { last_activity: '2026-11-20T10:00:00Z', provider: 'claude', session: 'x"><b>', models: 'm', input: 5, cached: 2, output: 1, total: 6 });
  const cell = sessionColumns.find((c) => c.key === 'session').render(rows[0].session, rows[0]);
  assert.doesNotMatch(cell, /<b>/);
  assert.deepEqual(sessionColumns.filter((c) => c.sortable).map((c) => c.key), ['last_activity', 'provider', 'input', 'cached', 'output', 'total']);
});

test('the sessions query and pager follow the server answer', () => {
  assert.equal(sessionsQuery({ sort: 'total', dir: 'asc', page: 2, pageSize: 10 }), 'sort=total&dir=asc&page=2&page_size=10');
  assert.equal(pagerState({ total: 10, page_size: 10, page: 0 }).hidden, true);
  assert.deepEqual(pagerState({ total: 25, page_size: 10, page: 1 }), { page: 1, pageSize: 10, totalItems: 25, totalPages: 3, hidden: false });
});

test('the Agents tab lives on the dashboard page and uses no breakpoints', async () => {
  const html = await readFile(new URL('../../static/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /<app-shell full-width active-href="\/dashboard"><dashboard-app>/);
  assert.match(html, /\/static\/agents\/agents\.css/);
  const css = await readFile(new URL('../../static/agents/agents.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@media|:host/);
  const selectors = css.split('\n').filter((line) => /^[a-z.]/.test(line)).map((line) => line.split(/[ ,{]/)[0]);
  assert.ok(selectors.every((first) => first === 'agents-tab' || first === '.agents-body'), 'every rule is scoped to the tab');
});

test('the dashboard has a Debian tab and an Agents tab, each with its own address', () => {
  assert.deepEqual(Object.keys(TABS), ['debian', 'agents']);
  assert.deepEqual(Object.values(TABS).map((t) => t.path), ['/dashboard', '/dashboard/agents']);
  assert.deepEqual(Object.values(tabBarTabs()).map((t) => t.label), ['Debian', 'Agents']);
});

test('an address opens its tab, with or without a trailing slash, and anything else opens Debian', () => {
  assert.equal(tabForPath('/dashboard/agents'), 'agents');
  assert.equal(tabForPath('/dashboard/agents/'), 'agents');
  assert.equal(tabForPath('/dashboard'), 'debian');
  assert.equal(tabForPath('/dashboard/nope'), 'debian');
  assert.equal(tabForPath(undefined), 'debian');
});

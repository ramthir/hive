import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reportUrl, renderReport, reportTables, fillTables, money, dailyChart, dailyPanel, monthOptions } from '../../static/limark/openai-format.js';

const cellText = html => html.replace(/<[^>]+>/g, '');
const details = html => JSON.parse(/data-tooltip-details="([^"]*)"/.exec(html)[1]
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

const data = () => ({ projects: [], totals: [{ amount: '2.50', currency: 'usd' }], project_costs: [{ name: '<script>bad()</script>', input_tokens: 100, input_cached_tokens: 40, output_tokens: 20, num_model_requests: 2, costs: [{ amount: '2.50', currency: 'usd' }] }], models: [{ model: '<img src=x>', input_tokens: 100, input_cached_tokens: 40, output_tokens: 20, num_model_requests: 2, costs: [{ amount: '1.25', currency: 'usd' }] }], daily: [{ date: '2026-09-01', amount: '2.50', currency: 'usd' }] });


test('filters request only the persisted-report API and encode project IDs', () => {
  assert.equal(reportUrl('2026-09', ''), '/api/limark/openai?month=2026-09&view=dashboard');
  assert.equal(new URL(reportUrl('2026-09', 'a&b'), 'http://test').searchParams.get('project'), 'a&b');
});

test('report renders separate spend, model usage, cached tokens and sections with shared tables', () => {
  const html = renderReport(data());
  assert.ok(!html.includes('Billing breakdown'));
  assert.ok(!html.includes('<h2>Usage by model</h2>') && !html.includes('Completion usage.'));
  assert.equal((html.match(/<app-table data-report=/g) || []).length, 2);
  assert.ok(!html.includes('Daily spend'));
  assert.ok(!html.includes('<script>'));
  const tables = reportTables(data());
  assert.deepEqual(tables.models.columns.map(c => c.label), ['Model', 'Input', 'Cached', 'Output', 'Total', 'Cost']);
  assert.equal(tables.billing, undefined);
  const cost = tables.models.columns.at(-1);
  assert.equal(cellText(cost.render(null, tables.models.rows[0])), '$1.25');
  assert.equal(cost.sortValue(null, tables.models.rows[0]), 1.25);
  assert.equal(cost.render(null, { costs: [] }), '—');
  assert.equal(cellText(cost.render(null, { costs: [{ amount: '1', currency: 'usd' }, { amount: '2', currency: 'eur' }] })), '$1.00 · €2.00');
  assert.deepEqual(tables.projects.columns.map(c => c.label), ['Project', 'Input', 'Cached', 'Output', 'Total', 'Cost']);
  const spend = tables.projects.columns.at(-1);
  assert.equal(spend.sortValue(null, tables.projects.rows[0]), 2.5);
  assert.ok(spend.render(null, tables.projects.rows[0]).includes('2.50'));
  assert.ok(html.indexOf('class="chart-card"') < 0 && html.indexOf('chart-card') < html.indexOf('data-report="models"') && html.indexOf('data-report="models"') < html.indexOf('data-report="projects"'));
});

test('fillTables hands each app-table its columns, rows and empty state', () => {
  const calls = [];
  const elements = ['models', 'projects'].map(report => ({ dataset: { report }, setColumns: c => calls.push([report, 'columns', c.length]), setEmptyState: e => calls.push([report, 'empty', e.title]), setData: r => calls.push([report, 'rows', r.length]) }));
  fillTables({ querySelectorAll: () => elements }, data());
  assert.deepEqual(calls.filter(c => c[0] === 'models'), [['models', 'columns', 6], ['models', 'empty', 'No model usage for this selection.'], ['models', 'rows', 1]]);
});

test('empty, stale and unavailable reports give an explanation without a misleading zero spend', () => {
  const empty = { totals: [], project_costs: [], models: [], daily: [], message: 'Sync is stale <retry>' };
  const html = renderReport(empty);
  assert.ok(html.includes('Sync is stale &lt;retry&gt;'));
  assert.ok(html.includes('—'));
  assert.equal(reportTables(empty).models.empty, 'No model usage for this selection.');
});

test('daily chart shows every day of the month per currency with dollar tooltips and keeps negative credits out of the bars', () => {
  const rows = [{ date: '2026-09-01', currency: 'usd', amount: '2.50' }, { date: '2026-09-03', currency: 'eur', amount: '2' }];
  const html = dailyChart(rows, '2026-09');
  assert.equal((html.match(/role="img"/g) || []).length, 0);
  assert.equal((html.match(/class="trend"/g) || []).length, 2);
  assert.equal((html.match(/<li class="bar"/g) || []).length, 60);
  assert.ok(html.includes('data-tooltip-title="September 1" data-tooltip-details='));
  assert.ok(html.includes('no spend recorded'));
  assert.ok(html.includes('<li>$2.5</li>') && html.includes('<li>$0</li>'));
  assert.equal(dailyChart([{ date: '2026-09-01', currency: 'usd', amount: -1 }], '2026-09'), '');
  assert.ok(money(-2, 'usd').includes('-'));
});

test('daily panel is headed by the month name and has no duplicate table', () => {
  const html = dailyPanel({ month: '2026-09', daily: [{ date: '2026-09-01', currency: 'usd', amount: '2.50' }] });
  assert.ok(html.includes('<h3>September 2026</h3>'));
  assert.ok(!html.includes('app-table'));
  assert.ok(dailyPanel({ month: '2026-09', daily: [] }).includes('No daily spend for this selection.'));
});

test('month options list two years newest first and keep an older selected month', () => {
  const options = monthOptions('2026-10');
  assert.equal(options.length, 24);
  assert.deepEqual(options[0], { value: '2026-10', label: 'October 2026' });
  assert.equal(options[1].value, '2026-09');
  assert.equal(options[12].value, '2025-10');
  assert.equal(options.at(-1).value, '2024-11');
  assert.equal(monthOptions('2026-10', '2020-05').at(-1).label, 'May 2020');
});

test('project usage columns use their own counts and retain usage-only projects', () => {
  const rows = [{ name: 'Usage only', input_tokens: 120, input_cached_tokens: 30, output_tokens: 50, num_model_requests: 7, costs: [] }];
  const table = reportTables({ project_costs: rows }).projects;
  assert.equal(table.rows, rows);
  for (const key of ['input_tokens', 'output_tokens', 'input_cached_tokens']) {
    const column = table.columns.find(c => c.key === key);
    assert.equal(column.sortable, true);
    assert.equal(cellText(column.render(rows[0][key])), String(rows[0][key]));
  }
  assert.equal(table.columns.at(-1).render(null, rows[0]), '—');
});

test('both tables calculate and sort Total as input plus output without adding cached input again', () => {
  const tables = reportTables(data());
  for (const table of [tables.models, tables.projects]) {
    const total = table.columns.find(c => c.key === 'total_tokens');
    assert.equal(cellText(total.render(undefined, table.rows[0])), '120');
    assert.equal(total.sortValue(undefined, table.rows[0]), 120);
    assert.equal(cellText(total.render(undefined, { input_tokens: 100, input_cached_tokens: 100, output_tokens: 0 })), '100');
    assert.equal(total.sortValue(undefined, {}), 0);
    assert.ok(!table.columns.some(c => c.key === 'num_model_requests'));
  }
});

test('model token tooltips show sorted project breakdowns then the exact total', () => {
  const row = { input_tokens: 100, output_tokens: 20, input_cached_tokens: 40,
    projects: [{ name: 'Beta', input_tokens: 20, output_tokens: 10, input_cached_tokens: 10 },
               { name: 'Alpha', input_tokens: 80, output_tokens: 10, input_cached_tokens: 30 }] };
  const table = reportTables({ models: [row] }).models;
  const input = table.columns.find(c => c.key === 'input_tokens').render(100, row);
  assert.deepEqual(details(input), [{ label: 'Alpha', value: '80' }, { label: 'Beta', value: '20' }, { label: 'Total', value: '100' }]);
  assert.ok(input.includes('tabindex="0"'));
  const total = table.columns.find(c => c.key === 'total_tokens').render(null, row);
  assert.deepEqual(details(total), [{ label: 'Alpha', value: '90' }, { label: 'Beta', value: '30' }, { label: 'Total', value: '120' }]);
});

test('project tooltips show model details, exclude billing-only entries from tokens and include their cost', () => {
  const row = { input_tokens: 100, costs: [{ currency: 'usd', amount: '3' }], models: [
    { model: 'gpt-test', input_tokens: 100, costs: [{ currency: 'usd', amount: '1' }] },
    { model: 'Other billed items', billing_only: true, costs: [{ currency: 'usd', amount: '2' }] }] };
  const table = reportTables({ project_costs: [row] }).projects;
  assert.deepEqual(details(table.columns[1].render(100, row)), [{ label: 'gpt-test', value: '100' }, { label: 'Total', value: '100' }]);
  assert.deepEqual(details(table.columns.at(-1).render(null, row)), [{ label: 'Other billed items', value: '$2.00' }, { label: 'gpt-test', value: '$1.00' }, { label: 'Total', value: '$3.00' }]);
});

test('cost tooltip currencies stay separate, credits survive and hostile labels are safely encoded', () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const row = { costs: [{ currency: 'usd', amount: '-1' }, { currency: 'eur', amount: '2' }], projects: [
    { name: hostile, costs: [{ currency: 'usd', amount: '-1' }, { currency: 'eur', amount: '2' }] }] };
  const html = reportTables({ models: [row] }).models.columns.at(-1).render(null, row);
  assert.ok(!html.includes('<img'));
  const cells = html.split(' · ');
  assert.deepEqual(details(cells[0]), [{ label: hostile, value: '-$1.00' }, { label: 'Total', value: '-$1.00' }]);
  assert.deepEqual(details(cells[1]), [{ label: hostile, value: '€2.00' }, { label: 'Total', value: '€2.00' }]);
});

test('daily bar tooltips show sorted project contributions and the signed total per currency', () => {
  const rows = [{ date: '2026-09-01', currency: 'usd', amount: '3', projects: [
    { name: 'Beta', amount: '-1' }, { name: 'Alpha <unsafe>', amount: '4' }] },
    { date: '2026-09-01', currency: 'eur', amount: '2', projects: [{ name: 'Euro project', amount: '2' }] }];
  const html = dailyChart(rows, '2026-09');
  const bars = [...html.matchAll(/<li class="bar"[^>]*>/g)].map(match => match[0]);
  assert.deepEqual(details(bars[0]), [{ label: 'Alpha <unsafe>', value: '$4.00' }, { label: 'Beta', value: '-$1.00' }, { label: 'Total', value: '$3.00' }]);
  assert.ok(!bars[1].includes('data-tooltip'));
  assert.ok(!bars[1].includes('tabindex'));
  assert.deepEqual(details(bars[30]), [{ label: 'Euro project', value: '€2.00' }, { label: 'Total', value: '€2.00' }]);
  assert.ok(!html.includes('<unsafe>'));
  assert.ok(bars[0].includes('tabindex="0"'));
});

test('zero and missing daily costs have no tooltip or keyboard stop, including offsetting project costs', () => {
  const rows = [{ date: '2026-09-01', currency: 'usd', amount: '1', projects: [] },
    { date: '2026-09-02', currency: 'usd', amount: '0.00', projects: [{ name: 'Charge', amount: '5' }, { name: 'Credit', amount: '-5' }] },
    { date: '2026-09-03', currency: 'usd', amount: '-1', projects: [{ name: 'Credit', amount: '-1' }] }];
  const html = dailyChart(rows, '2026-09');
  const bars = [...html.matchAll(/<li class="bar"[^>]*>/g)].map(match => match[0]);
  for (const index of [1, 3, 29]) {
    assert.ok(!bars[index].includes('data-tooltip'));
    assert.ok(!bars[index].includes('tabindex'));
  }
  assert.ok(bars[0].includes('data-tooltip-details'));
  assert.deepEqual(details(bars[2]).at(-1), { label: 'Total', value: '-$1.00' });
});

test('the spend card exposes successful sync time and missing-sync state without adding header clutter', () => {
  assert.ok(renderReport({ ...data(), last_success_at: '2026-10-30T00:00:00Z' }).includes('data-tooltip="Last successful sync:'));
  assert.ok(renderReport(data()).includes('data-tooltip="Awaiting the first successful sync"'));
});

test('stat cards and tables share Na\'vi token and spend colors', async () => {
  const html = renderReport(data());
  assert.match(html, /<stat-card title="Billed spend"[^>]*color="var\(--color-purple\)"/);
  assert.match(html, /<stat-card title="Input tokens"[^>]*color="var\(--color-blue\)"/);
  assert.match(html, /<stat-card title="Output tokens"[^>]*color="var\(--color-green\)"/);
  assert.doesNotMatch(html, /<stat-card title="Model requests"[^>]*color=/);

  const tables = reportTables(data());
  for (const name of ['models', 'projects']) {
    const cols = tables[name].columns;
    assert.equal(cols.find(c => c.label === 'Input').className, 'num input');
    assert.equal(cols.find(c => c.label === 'Output').className, 'num output');
    assert.equal(cols.find(c => c.label === 'Cached').className, 'num cached');
    assert.equal(cols.find(c => c.label === 'Total').className, 'num totals');
  }

  const css = await readFile(new URL('../../static/limark/usage.css', import.meta.url), 'utf8');
  assert.match(css, /\.limark-page \.data-table th\.input, \.limark-page \.data-table td\.input \{ color: var\(--color-blue\); \}/);
  assert.match(css, /\.limark-page \.data-table th\.cached, \.limark-page \.data-table td\.cached \{ color: var\(--color-yellow\); \}/);
  assert.match(css, /\.limark-page \.data-table th\.output, \.limark-page \.data-table td\.output \{ color: var\(--color-green\); \}/);
  assert.match(css, /\.limark-page \.data-table th\.totals, \.limark-page \.data-table td\.totals \{ color: var\(--color-purple\); font-weight: 600; \}/);
});

test('money rounds all currency amounts to exactly two decimal places', () => {
  assert.equal(money(12.5, 'usd'), '$12.50');
  assert.equal(money('1.2345', 'usd'), '$1.23');
  assert.equal(money('1.2356', 'usd'), '$1.24');
  assert.equal(money(0.004, 'usd'), '$0.00');
  assert.equal(money(0.006, 'usd'), '$0.01');
  assert.equal(money(1234.5, 'eur'), '€1,234.50');
});

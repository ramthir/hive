import { escapeHtml as esc } from '../html.js';
import { niceMax } from '../agents/usage-render.js';
import { renderStatCard } from '../components/stat-card-render.js';

export const number = (value) => new Intl.NumberFormat('en-US').format(value || 0);
export function money(amount, currency, maximumFractionDigits = 2) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits }).format(Number(amount)); }
  catch { return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits })} ${currency}`; }
}
export function reportUrl(month, project) {
  const query = new URLSearchParams({ month, view: 'dashboard' });
  if (project) query.set('project', project);
  return `/api/limark/openai?${query}`;
}
export function renderReport(data) {
  const models = data.models || [];
  const requests = models.reduce((total, row) => total + row.num_model_requests, 0);
  const input = models.reduce((total, row) => total + row.input_tokens, 0);
  const output = models.reduce((total, row) => total + row.output_tokens, 0);
  const notice = data.message ? `<p class="notice" role="status">${esc(data.message)}</p>` : '';
  const cards = [
    ['Billed spend', data.totals.length ? data.totals.map(t => money(t.amount, t.currency)).join(' · ') : '—', 'fa-coins', 'var(--color-purple)'],
    ['Model requests', number(requests), 'fa-arrow-right-arrow-left'],
    ['Input tokens', number(input), 'fa-arrow-right-to-bracket', 'var(--color-blue)'],
    ['Output tokens', number(output), 'fa-arrow-right-from-bracket', 'var(--color-green)'],
  ];
  const updated = data.last_success_at
    ? `Last successful sync: ${new Date(data.last_success_at).toLocaleString('en-US')}`
    : 'Awaiting the first successful sync';
  return `${notice}<div class="stat-card-grid metric-grid">${cards.map(([title, value, icon, color], index) => renderStatCard({
    title,
    value,
    icon,
    color,
    attrs: index === 0 ? { tabindex: '0', 'data-tooltip-title': 'Report freshness', 'data-tooltip': updated } : undefined,
  })).join('')}</div>
  ${dailyPanel(data)}
  <section class="report-panel">${tableCard('models', 'Usage by model')}</section>
  <section class="report-panel">${tableCard('projects', 'Spend by project')}</section>`;
}
const tableCard = (id, label) => `<div class="table-card"><app-table data-report="${id}" aria-label="${esc(label)}"></app-table></div>`;
// Cached input is already included in input_tokens.
const totalTokens = row => (row.input_tokens || 0) + (row.output_tokens || 0);
const tooltipCell = (text, title, details) => `<span tabindex="0" data-tooltip-title="${esc(title)}" data-tooltip-details="${esc(JSON.stringify(details))}">${esc(text)}</span>`;
const detailLabel = row => row.name || row.model || 'Unattributed';
const tokenCell = (value, row, key, label, breakdown) => {
  const getValue = entry => key === 'total_tokens' ? totalTokens(entry) : entry[key] || 0;
  const details = (row[breakdown] || []).filter(entry => !entry.billing_only)
    .map(entry => ({ label: detailLabel(entry), amount: getValue(entry) }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
    .map(entry => ({ label: entry.label, value: number(entry.amount) }));
  details.push({ label: 'Total', value: number(value) });
  return tooltipCell(number(value), label, details);
};
const tokenColumns = breakdown => [
  ...[['input_tokens', 'Input', 'input'], ['input_cached_tokens', 'Cached', 'cached'], ['output_tokens', 'Output', 'output']]
    .map(([key, label, cls]) => ({ key, label, className: `num ${cls}`, sortable: true,
      render: (value, row = {}) => tokenCell(value || 0, row, key, label, breakdown) })),
  { key: 'total_tokens', label: 'Total', className: 'num totals', sortable: true,
    sortValue: (_value, row) => totalTokens(row),
    render: (_value, row) => tokenCell(totalTokens(row), row, 'total_tokens', 'Total', breakdown) },
];
const costColumn = breakdown => ({
  key: 'costs', label: 'Cost', className: 'num', sortable: true,
  sortValue: (_value, row) => (row.costs || []).reduce((sum, c) => sum + Number(c.amount), 0),
  render: (_value, row) => row.costs?.length ? row.costs.map(cost => {
    const details = (row[breakdown] || []).flatMap(entry => (entry.costs || [])
      .filter(c => c.currency === cost.currency)
      .map(c => ({ label: detailLabel(entry), amount: Number(c.amount) })))
      .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
      .map(entry => ({ label: entry.label, value: money(entry.amount, cost.currency) }));
    details.push({ label: 'Total', value: money(cost.amount, cost.currency) });
    return tooltipCell(money(cost.amount, cost.currency), 'Cost', details);
  }).join(' · ') : '—',
});
export function reportTables(data) {
  return {
    models: { columns: [{ key: 'model', label: 'Model' }, ...tokenColumns('projects'), costColumn('projects')], rows: data.models || [], empty: 'No model usage for this selection.' },
    projects: { columns: [{ key: 'name', label: 'Project' }, ...tokenColumns('models'), costColumn('models')], rows: data.project_costs || [], empty: 'No billed spend for this selection.' },
  };
}
export function fillTables(root, data) {
  const tables = reportTables(data);
  for (const element of root.querySelectorAll('app-table[data-report]')) {
    const { columns, rows, empty } = tables[element.dataset.report];
    element.setColumns(columns);
    element.setEmptyState({ icon: 'fa-table-list', title: empty });
    element.setData(rows);
  }
}
const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const axisMoney = (value, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 2 }).format(value); }
  catch { return String(+value.toFixed(2)); }
};
/** Every day of the month so the axis is the same length all month; falls back to the days with data. */
function monthDays(month, days) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) return days;
  const count = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
/** Daily billed spend as the Navi usage chart: one bar per day of the month, a rounded axis in the billing currency, and the shared tooltip. */
export function dailyChart(rows, month, { credits = false, categories } = {}) {
  if (categories) return stackedDailyChart(rows, month, categories);
  const currencies = [...new Set(rows.map(r => r.currency))];
  return currencies.map(currency => {
    const daily = new Map(rows.filter(r => r.currency === currency).map(r => [r.date, r]));
    const spend = new Map([...daily].map(([date, row]) => [date, Number(row.amount)]));
    const magnitudes = [...spend.values()].map(value => credits ? Math.abs(value) : Math.max(0, value));
    const peak = niceMax(Math.max(0, ...magnitudes));
    if (!Math.max(0, ...magnitudes)) return '';
    const bars = monthDays(month, [...spend.keys()].sort()).map(date => {
      const value = credits ? Math.abs(spend.get(date) ?? 0) : Math.max(0, spend.get(date) ?? 0);
      const amount = spend.get(date) ?? 0;
      const text = `${dayLabel(date)}: ${money(amount, currency)}`;
      const details = [...(daily.get(date)?.projects || [])]
        .sort((a, b) => Number(b.amount) - Number(a.amount) || a.name.localeCompare(b.name))
        .map(project => ({ label: project.name, value: money(project.amount, currency) }));
      details.push({ label: 'Total', value: money(amount, currency) });
      const tip = amount !== 0
        ? `tabindex="0" data-tooltip-title="${esc(dayLabel(date))}" data-tooltip-details="${esc(JSON.stringify(details))}" data-tooltip-anchor=".fill"`
        : '';
      return `<li class="bar" ${tip}><span class="sr">${esc(spend.has(date) ? text : `${dayLabel(date)}: no spend recorded`)}</span><span class="stack" aria-hidden="true"><span class="fill${credits && amount < 0 ? ' credit' : ''}" style="height:${(value / peak * 100).toFixed(2)}%"></span></span><span class="tick" aria-hidden="true">${esc(date.slice(8))}</span></li>`;
    }).join('');
    const axis = [peak, peak / 2, 0].map(v => `<li>${esc(axisMoney(v, currency))}</li>`).join('');
    const label = currencies.length > 1 ? `<p class="muted">${esc(currency.toUpperCase())}</p>` : '';
    return `${label}<div class="chart"><ul class="axis" aria-hidden="true">${axis}</ul><div class="plot"><div class="grid" aria-hidden="true"><i></i><i></i><i></i></div><ol class="trend" aria-label="${esc(currency.toUpperCase())} daily spend">${bars}</ol></div></div>`;
  }).join('');
}
/** Category stacks share the month panel and axis styling; credits extend below zero. */
function stackedDailyChart(rows, month, categories) {
  const currencies = [...new Set(rows.map(row => row.currency))];
  return currencies.map(currency => {
    const days = new Map(rows.filter(row => row.currency === currency).map(row => [row.date, row]));
    const parts = row => categories.map(category => ({ ...category,
      amount: Number((row?.categories || []).find(part => part.category === category.key)?.amount || 0) }));
    const values = [...days.values()].map(parts);
    const hasCredits = values.some(parts => parts.some(part => part.amount < 0));
    const maximum = Math.max(0, ...values.flatMap(parts => [
      parts.reduce((sum, part) => sum + Math.max(0, part.amount), 0),
      parts.reduce((sum, part) => sum + Math.max(0, -part.amount), 0),
    ]));
    if (!maximum) return '';
    const peak = niceMax(maximum), range = peak * (hasCredits ? 2 : 1), baseline = hasCredits ? peak : 0;
    const bars = monthDays(month, [...days.keys()].sort()).map(date => {
      const row = days.get(date), segments = parts(row);
      const details = segments.filter(part => part.amount !== 0).map(part => ({ label: part.label, value: money(part.amount, currency) }));
      details.push({ label: 'Total', value: money(row?.amount || 0, currency) });
      let positive = 0, negative = 0;
      const fills = segments.filter(part => part.amount !== 0).map(part => {
        const bottom = part.amount > 0 ? baseline + positive : baseline - negative + part.amount;
        if (part.amount > 0) positive += part.amount; else negative -= part.amount;
        return `<span class="fill ${esc(part.className)}" style="bottom:${(bottom / range * 100).toFixed(4)}%;height:${(Math.abs(part.amount) / range * 100).toFixed(4)}%"></span>`;
      }).join('');
      const tip = fills ? `tabindex="0" data-tooltip-title="${esc(dayLabel(date))}" data-tooltip-details="${esc(JSON.stringify(details))}" data-tooltip-anchor=".bar-anchor"` : '';
      return `<li class="bar" ${tip}><span class="sr">${esc(dayLabel(date))}: ${row ? esc(money(row.amount, currency)) : 'no spend recorded'}</span><span class="stack category-stack" aria-hidden="true"><span class="bar-anchor" style="bottom:${((baseline - negative) / range * 100).toFixed(4)}%;height:${((positive + negative) / range * 100).toFixed(4)}%"></span>${fills}</span><span class="tick" aria-hidden="true">${date.slice(8)}</span></li>`;
    }).join('');
    const axis = (hasCredits ? [peak, 0, -peak] : [peak, peak / 2, 0]).map(value => `<li>${esc(axisMoney(value, currency))}</li>`).join('');
    const label = currencies.length > 1 ? `<p class="muted">${esc(currency.toUpperCase())}</p>` : '';
    return `${label}<div class="chart"><ul class="axis" aria-hidden="true">${axis}</ul><div class="plot"><div class="grid" aria-hidden="true"><i></i><i></i><i></i></div><ol class="trend" aria-label="${esc(currency.toUpperCase())} daily spend by category">${bars}</ol></div></div>`;
  }).join('');
}
const monthLabel = (month) => (/^\d{4}-\d{2}$/.test(month || '') ? new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'This month');
/** The Navi usage panel: the month name as its heading, with the daily bars below. */
export function dailyPanel(data, options) {
  const chart = dailyChart(data.daily || [], data.month, options);
  return `<section class="report-panel chart-card"><div class="panel-head"><h3>${esc(monthLabel(data.month))}</h3>${options?.categories ? `<ul class="chart-legend" aria-label="Chart categories">${options.categories.map(category => `<li><span class="legend-swatch ${esc(category.className)}" aria-hidden="true"></span>${esc(category.label)}</li>`).join('')}</ul>` : ''}</div>${chart || '<p class="muted">No daily spend for this selection.</p>'}</section>`;
}

const MONTH_COUNT = 24;
/** The last two years of months, newest first, plus the selected month when it falls outside them. */
export function monthOptions(current, selected = current) {
  const [year, month] = current.split('-').map(Number);
  const values = Array.from({ length: MONTH_COUNT }, (_, i) => new Date(Date.UTC(year, month - 1 - i, 1)).toISOString().slice(0, 7));
  if (selected && !values.includes(selected)) values.push(selected);
  return values.map(value => ({ value, label: monthLabel(value) }));
}

import { sessionResumeCommand } from './session-resume.js';
import { quotaDonut } from './quota-donuts.js';
import { escapeHtml as esc } from '../html.js';
import { formatRelativeTime } from '../relative-time.js';

const formatFullDateTime = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); };

export const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const PROVIDER_COLORS = { claude: 'var(--color-orange)', codex: 'var(--color-blue)', antigravity: 'var(--color-purple)' };
export const SESSION_PAGE_SIZE = 10;
// Three significant digits (275M, 9.18M, 70.4K) so the largest figure still fits the small Input, Cached and Output tiles.
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
export const compact = (value) => compactFormat.format(value);
const amountFormat = new Intl.NumberFormat('en-US', { notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Tooltip amounts always carry two decimals so the values line up in a column. */
export const tooltipAmount = (value) => amountFormat.format(value);
const exact = (value) => value.toLocaleString('en-US');
const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Oct 24–29": the report covers one month, so the second day drops its month. */
export const period = (first, last) => (first === last ? dayLabel(first) : first.slice(0, 7) === last.slice(0, 7) ? `${dayLabel(first)}–${Number(last.slice(8))}` : `${dayLabel(first)} – ${dayLabel(last)}`);
const fullDayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (month) => (/^\d{4}-\d{2}$/.test(month || '') ? new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'This month');

/** Short label for a session ID. Codex IDs are rollout paths ending in a UUID, so the path prefix is not shown. */
export function shortSession(id) {
  const text = String(id ?? '');
  const uuid = text.match(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuid ? uuid[1] : text.split('/').pop().slice(0, 8);
}

/** Same tiles as the task Token Usage summary (filled icon tile, label, compact value); Totals leads and the breakdown sits below it. Totals carries the breakdown tooltip; the breakdown tiles have none. */
const metric = (provider, label, icon, value, tip = '') =>
  `<dl class="metric ${esc(label.toLowerCase())}"${tip}><dt><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${esc(label)}</span></dt><dd aria-label="${esc(provider)} ${label === 'Totals' ? 'total tokens' : esc(label.toLowerCase())} ${exact(value)}">${compact(value)}</dd></dl>`;

/** Totals tooltip: Input, Cached and Output in their tile colours, then the total. */
function totalsTip(t) {
  const rows = [
    { label: 'Input', value: exact(t.input), color: 'var(--color-blue)' },
    { label: 'Cached', value: exact(t.cached_input), color: 'var(--color-yellow)' },
    { label: 'Output', value: exact(t.output), color: 'var(--color-green)' },
    { label: 'Total', value: exact(t.total) },
  ];
  return ` data-tooltip-title="Totals" data-tooltip-details="${esc(JSON.stringify(rows))}"`;
}

/** One header fact; `tooltip` is the data-tooltip attributes for the shared app-tooltip, or empty for none. */
const fact = (icon, text, tooltip = '') => `<li${tooltip}><i class="${icon}" aria-hidden="true"></i><span>${text}</span></li>`;

/** Models tooltip: each model with its month total, largest first, then the provider's total; a model with no breakdown is listed by name. */
function modelsTooltip(provider) {
  const measured = provider.model_tokens || [];
  const known = new Set(measured.map((row) => row.model));
  const rows = [...measured.map((row) => ({ label: row.model, value: tooltipAmount(row.total) })), ...provider.models.filter((name) => !known.has(name)).map((name) => ({ label: name, value: '' }))];
  if (measured.length) rows.push({ label: 'Total', value: tooltipAmount(provider.tokens.total) });
  return ` data-tooltip-title="${provider.models.length === 1 ? 'Model' : 'Models'}" data-tooltip-details="${esc(JSON.stringify(rows))}"`;
}

/** The Totals tile (with the quota rings beside it) above the Input, Cached and Output tiles. */
const metricsBlock = (label, t, donut) =>
  `<div class="metrics" role="group" aria-label="${esc(label)} token summary"><div class="totals-row">${metric(label, 'Totals', 'fa-layer-group', t.total, totalsTip(t))}${donut}</div><div class="subs">${metric(label, 'Input', 'fa-arrow-right-to-bracket', t.input)}${metric(label, 'Cached', 'fa-bolt', t.cached_input)}${metric(label, 'Output', 'fa-arrow-right-from-bracket', t.output)}</div></div>`;

function card(name, provider, quota) {
  const label = PROVIDER_LABELS[name] || name;
  const donut = quota ? quotaDonut(name, quota) : '';
  let body;
  let facts = '';
  if (provider.status === 'available' && provider.tokens) {
    const t = provider.tokens;
    const models = provider.models.length;
    body = metricsBlock(label, t, donut);
    facts = `<ul class="facts">${fact('fa-solid fa-comments', `${exact(provider.sessions)} ${provider.sessions === 1 ? 'session' : 'sessions'}`)}${fact('fa-solid fa-brain', `${models} ${models === 1 ? 'model' : 'models'}`, modelsTooltip(provider))}</ul>`;
  } else if (provider.status === 'no_usage') {
    const t = provider.tokens || { input: 0, cached_input: 0, output: 0, total: 0 };
    body = metricsBlock(label, t, donut);
    facts = `<ul class="facts">${fact('fa-solid fa-comments', '0 sessions')}</ul>`;
  } else if (provider.status === 'waiting') {
    const text = '<p class="state"><i class="fa-regular fa-hourglass-half" aria-hidden="true"></i><span>Waiting for this month\'s first report.</span></p>';
    body = donut ? `<div class="totals-row">${text}${donut}</div>` : text;
  } else {
    body = `<p class="state error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>Unavailable: ${esc(provider.reason || 'no report')}</span></p>`;
  }
  const head = `<header><h3><span class="dot ${esc(name)}" aria-hidden="true"></span>${esc(label)}</h3>${facts}</header>`;
  return `<article class="card" data-provider="${esc(name)}" data-state="${esc(provider.status)}">${head}${body}</article>`;
}

function banner(view) {
  if (view.status === 'ok') return '';
  const icon = view.status === 'stale' ? 'fa-hourglass-half' : 'fa-circle-exclamation';
  return `<div class="banner ${esc(view.status)}" role="status"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${esc(view.reason || '')}${view.status === 'stale' && view.generated_at ? ` Generated ${esc(formatRelativeTime(view.generated_at))}.` : ''}</span></div>`;
}

/** Smallest 1, 2, 2.5 or 5 times a power of ten that is at least `value`, so the axis ends on a round number. */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(value));
  const ratio = value / unit;
  return unit * [1, 2, 2.5, 5, 10].find((step) => ratio <= step + 1e-9);
}

/** Axis labels in one unit for the whole axis, taken from the top value: 0, 0.5B, 1B rather than 0, 500M, 1B. */
export function axisLabels(top) {
  const [div, suffix] = top >= 1e9 ? [1e9, 'B'] : top >= 1e6 ? [1e6, 'M'] : top >= 1e3 ? [1e3, 'K'] : [1, ''];
  const label = (value) => (value === 0 ? '0' : `${+(value / div).toFixed(2)}${suffix}`);
  return [top, top / 2, 0].map(label);
}

/** Every day of the month, so the axis is the same length all month; falls back to the days with data. */
function monthDays(month, days) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) return [...days.keys()].sort();
  const count = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** Stacked bars of total tokens per day; the data stays reachable as text through each bar's tooltip. */
export function renderTrend(view) {
  const days = new Map();
  for (const [name, provider] of Object.entries(view.providers || {})) {
    for (const entry of provider.daily || []) {
      if (!days.has(entry.date)) days.set(entry.date, {});
      days.get(entry.date)[name] = entry.total;
    }
  }
  if (!days.size) return '<p class="state">No daily usage this month.</p>';
  const ordered = monthDays(view.month, days).map((date) => [date, days.get(date) || {}]);
  const peak = niceMax(Math.max(...ordered.map(([, byProvider]) => Object.values(byProvider).reduce((sum, v) => sum + v, 0))));
  const last = view.covers?.to ?? '';
  const bars = ordered.map(([date, byProvider]) => {
    if (!Object.keys(byProvider).length) {
      const reached = date <= last;
      const tip = reached ? ` data-tooltip-title="${esc(fullDayLabel(date))}" data-tooltip="No usage recorded" data-tooltip-anchor=".fill"` : '';
      const quiet = reached ? `<span class="sr">${esc(dayLabel(date))}: no usage recorded</span>` : '';
      return `<li class="bar"${tip}>${quiet}<span class="stack" aria-hidden="true"><span class="fill" style="height:0"></span></span><span class="tick" aria-hidden="true">${esc(date.slice(8))}</span></li>`;
    }
    const total = Object.values(byProvider).reduce((sum, v) => sum + v, 0);
    const names = Object.keys(PROVIDER_LABELS).filter((n) => byProvider[n]);
    const rows = names.map((n) => ({ label: PROVIDER_LABELS[n], value: tooltipAmount(byProvider[n]), color: PROVIDER_COLORS[n] }));
    const text = `${dayLabel(date)}: ${exact(total)} tokens (${names.map((n) => `${PROVIDER_LABELS[n]} ${compact(byProvider[n])}`).join(', ')})`;
    // The fill is as tall as the day's total, so the tooltip sits just above the bar, not above the chart.
    const parts = names.map((n) => `<span class="seg ${esc(n)}" style="height:${(byProvider[n] / total * 100).toFixed(2)}%"></span>`).join('');
    return `<li class="bar" data-tooltip-title="${esc(fullDayLabel(date))}" data-tooltip-anchor=".fill" data-tooltip-details="${esc(JSON.stringify([...rows, { label: 'Total', value: tooltipAmount(total) }]))}"><span class="sr">${esc(text)}</span><span class="stack" aria-hidden="true"><span class="fill" style="height:${(total / peak * 100).toFixed(2)}%">${parts}</span></span><span class="tick" aria-hidden="true">${esc(date.slice(8))}</span></li>`;
  }).join('');
  const axis = axisLabels(peak).map((label) => `<li>${label}</li>`).join('');
  return `<div class="chart"><ul class="axis" aria-hidden="true">${axis}</ul><div class="plot"><div class="grid" aria-hidden="true"><i></i><i></i><i></i></div><ol class="trend" aria-label="Daily token usage">${bars}</ol></div></div>`;
}

const tokenCell = (kind, label) => (value) => `<span class="${kind}" aria-label="${label} ${exact(value)}">${compact(value)}</span>`;
const timestampOf = (value) => (value ? Date.parse(value) || 0 : 0);

/** Columns for the shared <app-table>: the same Input, Cached, Output and Total colours as the cards. */
export const sessionColumns = [
  { key: 'last_activity', label: 'Last activity', sortable: true, sortValue: timestampOf,
    render: (value) => (value ? `<span title="${esc(formatFullDateTime(value))}">${esc(formatRelativeTime(value))}</span>` : 'Unknown') },
  { key: 'provider', label: 'Provider', sortable: true,
    render: (value) => `<span class="dot ${esc(value)}" aria-hidden="true"></span>${esc(PROVIDER_LABELS[value] || value)}` },
  { key: 'session', label: 'Session', render: (value, row) => {
    const label = `<code title="${esc(value)}">${esc(shortSession(value))}</code>`;
    const command = sessionResumeCommand(row?.provider, value);
    return command
      ? `<button type="button" class="session-resume" data-session-resume="${esc(command)}" aria-label="Copy resume command: ${esc(command)}">${label} <i class="fa-regular fa-copy" aria-hidden="true"></i></button>`
      : `<span class="session-plain">${label}</span>`;
  } },
  { key: 'models', label: 'Model', render: (value) => esc(value || 'Unknown') },
  { key: 'input', label: 'Input', sortable: true, className: 'num input', render: tokenCell('input', 'Input') },
  { key: 'cached', label: 'Cached', sortable: true, className: 'num cached', render: tokenCell('cached', 'Cached') },
  { key: 'output', label: 'Output', sortable: true, className: 'num output', render: tokenCell('output', 'Output') },
  { key: 'total', label: 'Total', sortable: true, className: 'num totals', render: tokenCell('totals', 'Total') },
];

/** One page of sessions as rows for <app-table>; the server has already sorted them. */
export const sessionRows = (sessions) => (sessions || []).map((s) => ({
  last_activity: s.last_activity, provider: s.provider, session: s.session, models: (s.models || []).join(', '),
  input: s.tokens.input, cached: s.tokens.cached_input, output: s.tokens.output, total: s.tokens.total,
}));

/** Query string for one page of sessions; the server sorts across every session of the month. */
export const sessionsQuery = ({ sort, dir, page, pageSize }) => new URLSearchParams({ sort, dir, page: String(page), page_size: String(pageSize) }).toString();

/** What the shared pager needs for a page answer; hidden when everything fits on one page. */
export function pagerState(answer) {
  const pageSize = answer?.page_size || SESSION_PAGE_SIZE;
  const totalItems = answer?.total || 0;
  return { page: answer?.page || 0, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)), hidden: totalItems <= pageSize };
}

function sessionsPanel() {
  return `<section class="sessions"><div class="table-card"><app-table id="sessions-table" sort-mode="server" aria-label="Sessions"></app-table></div><app-pagination id="sessions-pager" hidden></app-pagination></section>`;
}

/** Placeholders shown until the first answer arrives, so the page does not jump from a text line to a full layout. */
function skeleton() {
  const tile = (label) => `<dl class="metric ${label.toLowerCase()}"><dt><i class="skeleton skeleton-icon"></i><span>${label}</span></dt><dd><span class="skeleton skeleton-value"></span></dd></dl>`;
  const card = (name) => `<article class="card" aria-hidden="true"><header><h3><span class="dot ${esc(name)}"></span>${esc(PROVIDER_LABELS[name])}</h3><ul class="facts skeleton-facts"><li><span class="skeleton skeleton-fact"></span></li><li><span class="skeleton skeleton-fact"></span></li></ul></header><div class="metrics"><div class="totals-row">${tile('Totals')}<span class="skeleton quota-skeleton"></span></div><div class="subs">${['Input', 'Cached', 'Output'].map(tile).join('')}</div></div></article>`;
  // Stable pseudo-random heights keep loading rerenders from jumping.
  const heights = [42, 76, 28, 63, 85, 37, 54, 22, 71, 46, 81, 33, 59, 25, 68, 49, 79, 35, 56, 20, 73, 44, 83, 31, 61, 26, 66, 51, 78, 39, 57];
  const bars = heights.map(height => `<li class="bar"><span class="stack"><span class="skeleton day-skeleton" style="--skeleton-height:${height}"></span></span><span class="tick"><span class="skeleton tick-skeleton"></span></span></li>`).join('');
  return `<div class="cards" aria-busy="true"><span class="sr" role="status">Loading usage…</span>${Object.keys(PROVIDER_LABELS).map(card).join('')}</div>
    <section class="panel" aria-hidden="true"><div class="panel-head"><span class="skeleton block-title"></span><ul class="legend skeleton-legend">${Object.keys(PROVIDER_LABELS).map(() => '<li><span class="skeleton skeleton-fact"></span></li>').join('')}</ul></div><div class="chart chart-skeleton"><ul class="axis"><li><span class="skeleton axis-skeleton"></span></li><li><span class="skeleton axis-skeleton"></span></li><li><span class="skeleton axis-skeleton"></span></li></ul><div class="plot"><div class="grid"><i></i><i></i><i></i></div><ol class="trend">${bars}</ol></div></div></section>
    ${sessionsPanel()}`;
}

function legend(view) {
  const names = Object.keys(view.providers || {}).filter((name) => (view.providers[name].daily || []).length);
  return names.length ? `<ul class="legend" aria-hidden="true">${names.map((name) => `<li><span class="dot ${esc(name)}"></span>${esc(PROVIDER_LABELS[name] || name)}</li>`).join('')}</ul>` : '';
}

/** "Updated 4m ago": how old the report on screen is, so a person can tell fresh numbers from a 15-minute-old report. */
export function updatedText(generatedAt) {
  const age = formatRelativeTime(generatedAt);
  return age ? `Updated ${age === 'Just now' ? 'just now' : age}` : '';
}

const updatedTime = (view) => (view.generated_at ? `<time class="updated" datetime="${esc(view.generated_at)}" title="${esc(formatFullDateTime(view.generated_at))}">${esc(updatedText(view.generated_at))}</time>` : '');

/** The whole tab body for one /api/agents/usage answer; `null` renders the loading state. */
export function renderUsage(view, quota = null) {
  if (!view) return skeleton();
  const cards = Object.entries(view.providers || {}).map(([name, provider]) => card(name, provider, quota?.providers?.[name])).join('');
  const trend = view.status === 'unavailable' || view.status === 'waiting' ? '<p class="state">No daily usage to show.</p>' : renderTrend(view);
  return `${banner(view)}
    <div class="cards">${cards}</div>
    <section class="panel"><div class="panel-head"><h3>${esc(monthLabel(view.month))}</h3>${updatedTime(view)}${legend(view)}</div>${trend}</section>
    ${sessionsPanel()}`;
}

/**
 * What decides whether the sessions table is drawn again: the answer, and the minute, so "5 min ago" is redrawn by the
 * page's minute poll even when the sessions themselves have not changed.
 */
export const sessionsKey = (answer, now = Date.now()) => JSON.stringify([answer, Math.floor(now / 60000)]);

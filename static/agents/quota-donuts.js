import { escapeHtml as esc } from '../html.js';

// Rings run outside in: the first entry is the outermost circle. Each ring has its own radius, stroke and colour.
const LAYOUT = [
  { key: '5h', kind: 'outer', radius: 50, stroke: 12, label: '5 hour' },
  { key: '7d', kind: 'inner', radius: 34, stroke: 12, label: 'Weekly' },
];

const percent = (window) => (window && window.state === 'ok' && typeof window.used_pct === 'number' ? window.used_pct : null);

/** Short time until a reset: "in 4h 52m" within a day, otherwise "in 6d 3h". */
export function resetText(window, now = new Date()) {
  if (!window || !window.resets_at) return '';
  const when = new Date(window.resets_at);
  if (Number.isNaN(when.getTime())) return '';
  const minutes = Math.round((when - now) / 60000);
  if (minutes <= 0) return 'reset';
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `in ${hours ? `${hours}h ` : ''}${rest}m`.replace(' 0m', '');
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return `in ${days}d${hours ? ` ${hours}h` : ''}`;
}

const LABELS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const shareLeft = (used) => Math.max(0, Math.min(100, 100 - used));

/** One row per ring: its label, remaining share and when it resets. */
function detail(window, label, now) {
  const used = percent(window);
  const reset = resetText(window, now);
  const state = window ? window.state : 'unavailable';
  if (used === null) {
    // Nothing captured: say why, never a percentage. A stale window still shows when its reset is due.
    const resetNote = reset === 'reset' ? ' · reset passed' : reset ? ` · resets ${reset}` : '';
    const note = {
      expired: '· reset, not measured yet',
      stale: `· no recent reading${resetNote}`,
    }[state] || '· not available';
    return { label, note, value: '–' };
  }
  return { label, note: reset ? `· resets ${reset}` : '', value: `${Math.round(shareLeft(used))}%` };
}

/** How worrying what is left is: under a tenth is critical, under a quarter a warning. */
export const quotaLevel = (left) => (left <= 10 ? 'low' : left <= 25 ? 'warn' : '');

/** One concentric ring: its track and the used arc. */
function ring(window, spec) {
  const circumference = 2 * Math.PI * spec.radius;
  const used = percent(window);
  const track = `<circle class="track" cx="60" cy="60" r="${spec.radius}" stroke-width="${spec.stroke}"></circle>`;
  // No reading: a dashed ring with no arc, so it is not mistaken for full or empty usage.
  if (used === null) return `<circle class="unknown" cx="60" cy="60" r="${spec.radius}" stroke-width="${spec.stroke}"></circle>`;
  // The arc is what is left: full when unused, shrinking as the window fills up.
  const left = shareLeft(used);
  // Zero left draws only the track, so round linecaps do not paint a colored dot on an exhausted ring.
  if (Math.round(left) <= 0) return track;
  const dash = (left / 100) * circumference;
  const level = quotaLevel(left);
  return `${track}<circle class="arc ${spec.kind}${level ? ` ${level}` : ''}" cx="60" cy="60" r="${spec.radius}" stroke-width="${spec.stroke}" stroke-dasharray="${dash} ${circumference}"></circle>`;
}

/** Tooltip detail rows for one provider's quota rings; exposed so the minute poll can tick countdowns in place. */
export function quotaTooltipDetails(name, provider, now = new Date()) {
  if (!provider || provider.status !== 'ok') return [];
  const windows = provider.windows || {};
  return LAYOUT.map(({ key, label }) =>
    detail(windows[key], name === 'antigravity' ? `Gemini ${label.toLowerCase()}` : label, now),
  );
}

/**
 * A short donut for one provider's quota, with the 5-hour ring outside the weekly ring. The tooltip names
 * each ring's percentage and reset. A provider without a source gets no donut.
 */
export function quotaDonut(name, provider, now = new Date()) {
  if (!provider || provider.status !== 'ok') return '';
  const windows = provider.windows || {};
  // The rings are not a total, so the tooltip is told not to draw its total rule above the last rows.
  const rows = quotaTooltipDetails(name, provider, now);
  const label = `${LABELS[name] || name} Quota`;
  return `<svg class="quota-donut" data-quota-provider="${esc(name)}" viewBox="0 0 120 120" role="img" tabindex="0" aria-label="${esc(label)}"
    data-tooltip-title="${esc(label)}" data-tooltip-no-total data-tooltip-details="${esc(JSON.stringify(rows))}">
    ${LAYOUT.map((spec) => ring(windows[spec.key], spec)).join('\n    ')}
  </svg>`;
}

export const QUOTA_PENDING = 'The quota is being collected.'; // what the server says while the first run is still reading the CLIs
export const QUOTA_MAX_RETRIES = 8; // at 8 s each: about a minute, after which the page's own minute poll tries again

/** Whether to ask for the quota again soon: only while the server says the first run is under way, and not for ever. */
export const shouldRetryQuota = (quota, attempts) => Boolean(quota) && !quota.generated_at && quota.reason === QUOTA_PENDING && attempts < QUOTA_MAX_RETRIES;

/** What goes beside a provider's Totals tile: its rings when ok, a placeholder while collecting, or a quiet info icon with why it failed. */
export function quotaIndicator(name, quota) {
  if (!quota) return '';
  if (!quota.generated_at && quota.reason === QUOTA_PENDING) {
    return '<span class="skeleton quota-skeleton" role="status" aria-label="Collecting quota" data-tooltip-title="Quota" data-tooltip="Collecting quota from the agent CLIs…"></span>';
  }
  const provider = quota.providers?.[name];
  if (!provider) return '';
  if (provider.status === 'ok') return quotaDonut(name, provider);
  if (provider.status === 'unavailable' && provider.reason) {
    const label = `${LABELS[name] || name} Quota`;
    return `<span class="quota-unavailable" tabindex="0" role="img" aria-label="${esc(label)} unavailable" data-tooltip-title="${esc(label)}" data-tooltip="${esc(provider.reason)}"><i class="fa-solid fa-circle-info" aria-hidden="true"></i></span>`;
  }
  return '';
}

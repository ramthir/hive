import { escapeHtml as esc } from '../html.js';

// Rings run outside in: the first entry is the outermost circle. Each ring has its own radius, stroke and colour.
const LAYOUTS = {
  default: [
    { key: '5h', kind: 'outer', radius: 50, stroke: 12, label: '5 hour' },
    { key: '7d', kind: 'inner', radius: 34, stroke: 12, label: 'Weekly' },
  ],
  antigravity: [
    { key: '5h', kind: 'outer', radius: 50, stroke: 10, label: 'Gemini 5 hour' },
    { key: '7d', kind: 'middle', radius: 36, stroke: 10, label: 'Gemini weekly' },
    { key: 'argon-7d', kind: 'argon', radius: 22, stroke: 10, label: 'Argon weekly' },
  ],
};

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
function detail(window, ring) {
  const used = percent(window);
  const reset = resetText(window);
  const state = window ? window.state : 'unavailable';
  if (used === null) {
    // Nothing captured: say why, never a percentage. A stale window still shows when its reset is due.
    const resetNote = reset === 'reset' ? ' · reset passed' : reset ? ` · resets ${reset}` : '';
    const note = {
      expired: '· reset, not measured yet',
      stale: `· no recent reading${resetNote}`,
    }[state] || '· not available';
    return { label: ring.label, note, value: '–' };
  }
  return { label: ring.label, note: reset ? `· resets ${reset}` : '', value: `${Math.round(shareLeft(used))}%` };
}

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
  return `${track}<circle class="arc ${spec.kind}" cx="60" cy="60" r="${spec.radius}" stroke-width="${spec.stroke}" stroke-dasharray="${dash} ${circumference}"></circle>`;
}

/**
 * A short donut for one provider's quota, rings from outside in as the provider's layout lists them. The tooltip names
 * each ring's percentage and reset. A provider without a source gets no donut.
 */
export function quotaDonut(name, provider) {
  if (!provider || provider.status !== 'ok') return '';
  const windows = provider.windows || {};
  const layout = LAYOUTS[name] || LAYOUTS.default;
  // The rings are not a total, so the tooltip is told not to draw its total rule above the last rows.
  const rows = layout.map((spec) => detail(windows[spec.key], spec));
  const label = `${LABELS[name] || name} Quota`;
  return `<svg class="quota-donut" viewBox="0 0 120 120" role="img" tabindex="0" aria-label="${esc(label)}"
    data-tooltip-title="${esc(label)}" data-tooltip-no-total data-tooltip-details="${esc(JSON.stringify(rows))}">
    ${layout.map((spec) => ring(windows[spec.key], spec)).join('\n    ')}
  </svg>`;
}

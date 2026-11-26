import { escapeHtml } from '../html.js';

export const STAT_CARD_GRID_CSS = `
  .stat-card-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-4, 1rem);
  }

  .stat-card-grid[hidden] {
    display: none;
  }

  .stat-card-grid stat-card {
    min-width: 0;
  }


`;

const PROP_TO_ATTR = [
  ['id', 'id'],
  ['className', 'class'],
  ['title', 'title'],
  ['icon', 'icon'],
  ['value', 'value'],
  ['sub', 'sub'],
  ['color', 'color'],
  ['progress', 'progress'],
  ['progressColor', 'progress-color'],
  ['statusColor', 'status-color'],
  ['targetLabel', 'target-label'],
  ['currentDay', 'current-day'],
  ['monthName', 'month-name'],
  ['badge', 'badge'],
  ['dailyProgress', 'daily-progress'],
  ['dailyTooltipTitle', 'daily-tooltip-title'],
  ['dailyTooltip', 'daily-tooltip'],
  ['segmentColors', 'segment-colors'],
  ['segments', 'segments'],
];

const BOOL_PROP_TO_ATTR = [
  ['status', 'status'],
  ['loading', 'loading'],
  ['allowOverflow', 'allow-overflow'],
];

/**
 * Render a `<stat-card>` HTML string from a structured props object.
 * Handles HTML escaping and optional attributes uniformly.
 */
export function renderStatCard(props = {}) {
  const attrs = [];
  for (const [prop, attr] of PROP_TO_ATTR) {
    const val = props[prop];
    if (val != null && val !== '') {
      attrs.push(`${attr}="${escapeHtml(val)}"`);
    } else if ((prop === 'progress' || prop === 'dailyProgress') && val === 0) {
      attrs.push(`${attr}="0"`);
    }
  }
  for (const [prop, attr] of BOOL_PROP_TO_ATTR) {
    if (props[prop]) {
      attrs.push(attr);
    }
  }
  if (props.attrs && typeof props.attrs === 'object') {
    for (const [key, val] of Object.entries(props.attrs)) {
      if (val === true) {
        attrs.push(escapeHtml(key));
      } else if (val != null && val !== false) {
        attrs.push(`${escapeHtml(key)}="${escapeHtml(val)}"`);
      }
    }
  }
  const attrString = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `<stat-card${attrString}>${props.slotHtml || ''}</stat-card>`;
}

/**
 * Create a `<stat-card>` DOM element from a structured props object.
 */
export function createStatCard(props = {}) {
  const el = document.createElement('stat-card');
  for (const [prop, attr] of PROP_TO_ATTR) {
    const val = props[prop];
    if (val != null && (val !== '' || prop === 'progress' || prop === 'dailyProgress')) {
      el.setAttribute(attr, String(val));
    }
  }
  for (const [prop, attr] of BOOL_PROP_TO_ATTR) {
    if (props[prop]) {
      el.setAttribute(attr, '');
    }
  }
  if (props.attrs && typeof props.attrs === 'object') {
    for (const [key, val] of Object.entries(props.attrs)) {
      if (val === true) {
        el.setAttribute(key, '');
      } else if (val != null && val !== false) {
        el.setAttribute(key, String(val));
      }
    }
  }
  if (props.slotHtml) {
    el.innerHTML = props.slotHtml;
  }
  return el;
}

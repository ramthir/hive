import './tooltip.js';
import { escapeHtml } from '../html.js';
import { formatDuration } from '../duration.js';

const SPARKLINE_CSS = `
  :host {
    display: inline-flex;
    align-self: center;
    flex-shrink: 0;
  }

  .sparkline {
    display: grid;
    grid-template-columns: repeat(7, 10px);
    gap: 2.5px;
    align-self: center;
    flex-shrink: 0;
  }

  .sparkline span {
    display: block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--color-blue) var(--activity-intensity), var(--color-dark2));
    outline: 1px solid color-mix(in srgb, var(--color-blue) calc(var(--activity-intensity) * 0.4), var(--color-dimmed5));
    outline-offset: -1px;
    transition: transform 0.15s ease, outline-color 0.15s ease;
    box-sizing: border-box;
    cursor: pointer;
  }

  .sparkline span:hover {
    transform: scale(1.35);
    z-index: 2;
    outline-color: var(--color-blue);
  }

  .sparkline span.placeholder {
    visibility: hidden;
    pointer-events: none;
  }

  .sparkline span.future {
    background: transparent;
    outline: none;
    border: 1px dotted var(--color-dimmed3);
    opacity: 0.65;
    cursor: default;
  }

  .sparkline span.future:hover {
    border-color: var(--color-blue);
    opacity: 0.95;
    outline: none;
    transform: scale(1.25);
    z-index: 2;
  }

  .sparkline span.today {
    outline: 1.5px solid var(--color-yellow);
    outline-offset: -1px;
  }
`;

const sparklineSheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null;
if (sparklineSheet) {
  sparklineSheet.replaceSync(SPARKLINE_CSS);
}

/**
 * Monthly activity calendar sparkline component.
 * Renders a 7-column grid of day tiles with intensity shading and hover tooltips.
 *
 * Attributes:
 *   - values: comma-separated daily minute counts
 *   - start: YYYY-MM-DD start date (defaults to 1st of current month)
 *   - details: JSON-encoded array of per-day tooltip detail rows
 */
export class ActivitySparkline extends HTMLElement {
  static get observedAttributes() {
    return ['values', 'start', 'details'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    if (sparklineSheet && 'adoptedStyleSheets' in this.shadowRoot) {
      this.shadowRoot.adoptedStyleSheets = [sparklineSheet];
    }
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this.render();
      this._rendered = true;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (!this._rendered || oldValue === newValue) return;
    this.render();
  }

  render() {
    const sparklineValues =
      this.getAttribute('values')
        ?.split(',')
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry)) || [];

    if (!sparklineValues.length) {
      this.shadowRoot.innerHTML = sparklineSheet ? '' : `<style>${SPARKLINE_CSS}</style>`;
      return;
    }

    const sparklineMax = Math.max(...sparklineValues, 0);

    let sparklineDetails = [];
    const detailsAttr = this.getAttribute('details');
    if (detailsAttr) {
      try {
        const parsed = JSON.parse(detailsAttr);
        if (Array.isArray(parsed)) sparklineDetails = parsed;
      } catch {
        // Ignore invalid sparkline details
      }
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const startDateAttr = this.getAttribute('start');
    let startDate;
    if (startDateAttr) {
      const [y, m, d] = startDateAttr.split('-').map(Number);
      startDate = new Date(y, m - 1, d);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const startDayOfWeek = startDate.getDay();
    const placeholders = Array.from({ length: startDayOfWeek }, () => '<span class="placeholder"></span>');

    const dayTiles = sparklineValues.map((entry, index) => {
      const tileDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index);
      const tileDateStr = `${tileDate.getFullYear()}-${String(tileDate.getMonth() + 1).padStart(2, '0')}-${String(tileDate.getDate()).padStart(2, '0')}`;
      const isToday = tileDateStr === todayStr;
      const isFuture = tileDateStr > todayStr;
      const intensity = sparklineMax ? Math.max(18, Math.round((entry / sparklineMax) * 100)) : 0;
      const finalIntensity = entry === 0 || isFuture ? 0 : intensity;

      const tooltipTitle = tileDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });

      const durationText = formatDuration(entry);

      const isWeekend = tileDate.getDay() === 0 || tileDate.getDay() === 6;

      let tooltipDesc = '';
      if (entry > 0) {
        tooltipDesc = isToday ? `${durationText} logged today` : `${durationText} logged`;
      } else if (isWeekend) {
        tooltipDesc = 'Weekend — No time logged';
      } else if (isToday) {
        tooltipDesc = 'No time logged today';
      } else if (isFuture) {
        tooltipDesc = 'Upcoming workday';
      } else {
        tooltipDesc = 'No time logged';
      }

      const classes = [isToday ? 'today' : '', isFuture ? 'future' : ''].filter(Boolean).join(' ');

      const dayDetails = sparklineDetails[index];
      const hasDetails = Array.isArray(dayDetails) && dayDetails.length > 0;
      const detailsAttrHtml = hasDetails ? ` data-tooltip-details="${escapeHtml(JSON.stringify(dayDetails))}" data-tooltip-wide` : '';
      const tooltipAttr = hasDetails ? '' : ` data-tooltip="${escapeHtml(tooltipDesc)}"`;
      const ariaDesc = hasDetails ? `${durationText} logged` : tooltipDesc;

      return `<span class="${classes}"${tooltipAttr} data-tooltip-title="${escapeHtml(tooltipTitle)}"${detailsAttrHtml} aria-label="${escapeHtml(tooltipTitle)}: ${escapeHtml(ariaDesc)}" style="--activity-intensity:${finalIntensity}%"></span>`;
    });

    const totalCells = startDayOfWeek + sparklineValues.length;
    const trailingCount = (7 - (totalCells % 7)) % 7;
    const trailingPlaceholders = Array.from({ length: trailingCount }, () => '<span class="placeholder"></span>');

    const fallbackStyle = sparklineSheet ? '' : `<style>${SPARKLINE_CSS}</style>`;
    this.shadowRoot.innerHTML = `${fallbackStyle}<div class="sparkline" aria-label="Monthly activity calendar">${placeholders.join('')}${dayTiles.join('')}${trailingPlaceholders.join('')}</div>`;
  }
}

if (!customElements.get('activity-sparkline')) {
  customElements.define('activity-sparkline', ActivitySparkline);
}

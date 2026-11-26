import './tooltip.js';
import { escapeHtml } from '../html.js';
export { STAT_CARD_GRID_CSS, renderStatCard, createStatCard } from './stat-card-render.js';

const formatIconClass = (icon) => {
  const raw = String(icon || 'fa-circle').trim() || 'fa-circle';
  if (/^(fa-solid|fa-regular|fa-brands|fa-light|fa-thin|fa-duotone|fas|far|fab)\b/.test(raw)) {
    return raw;
  }
  return `fa-solid ${raw}`;
};

const STAT_CARD_CSS = `
  :host {
    display: flex;
  }

  :host([allow-overflow]) .card {
    overflow: visible;
  }

  .card {
    flex: 1;
    /* A column, so a card taller than its content (the row's tallest sets the height) keeps its footer at the bottom. */
    display: flex;
    flex-direction: column;
    background: var(--color-dark1);
    border-radius: var(--radius-md, 8px);
    overflow: hidden;
    outline: 1px solid var(--color-dimmed5);
    outline-offset: -1px;
    transition: outline-color 0.22s ease;
    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  }

  .card:hover {
    outline-color: var(--color-dimmed4);
  }

  .card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: var(--space-5, 1.25rem) var(--space-6, 1.5rem);
    gap: var(--space-1, 0.25rem);
    min-width: 0;
  }

  .card-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }

  .content {
    flex: 1;
    min-width: 0;
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
  }

  .title {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .badge {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-full, 9999px);
    background: var(--color-dark2);
    outline: 1px solid var(--color-dimmed5);
    color: var(--color-dimmed2);
    white-space: nowrap;
  }

  .caption {
    padding: var(--space-2, 0.5rem) var(--space-6, 1.5rem);
    font-size: 0.75rem;
    color: var(--color-dimmed2);
  }

  .value {
    margin-top: var(--space-1, 0.25rem);
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.2;
  }

  .value.status {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    animation: pulse 2s infinite;
  }

  .sub {
    margin-top: var(--space-1, 0.25rem);
    font-size: 0.875rem;
    color: var(--color-dimmed2);
    /* One line, so a long line cannot make this card taller than the others in its row. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stat-skeleton {
    display: inline-block;
    vertical-align: middle;
    border-radius: 4px;
    background: var(--color-dimmed5);
    opacity: 0.7;
  }

  .stat-skeleton-value {
    width: 55%;
    height: 1.15rem;
  }

  .stat-skeleton-sub {
    width: 72%;
    height: 0.75rem;
  }

  .visual {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex-shrink: 0;
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--radius-full, 9999px);
    background: var(--color-dark2);
    outline: 1px solid var(--color-dimmed5);
    outline-offset: -1px;
    flex-shrink: 0;
  }

  .icon-wrapper.daily-progress {
    position: relative;
    outline: none;
    background: conic-gradient(var(--color-green) calc(var(--daily-progress) * 1%), var(--color-dimmed5) 0);
  }

  .icon-wrapper.daily-progress::before {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: inherit;
    background: var(--color-dark2);
  }

  .icon-wrapper i {
    font-size: 1rem;
    color: var(--color-blue);
    position: relative;
    z-index: 1;
  }

  .card-footer {
    border-top: 1px solid var(--color-dimmed5);
  }

  .progress {
    height: 5px;
    background: var(--color-dark2);
    overflow: hidden;
  }

  .progress.segmented {
    display: flex;
    gap: 2px;
  }

  .progress.segmented .progress-bar {
    flex: none;
    border-radius: 1px;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--color-blue) 0%, var(--color-green) 100%);
    transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const statCardSheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null;
if (statCardSheet) {
  statCardSheet.replaceSync(STAT_CARD_CSS);
}

export class StatCard extends HTMLElement {
  static get observedAttributes() {
    return [
      'title', 'icon', 'value', 'sub', 'color', 'progress', 'progress-color', 'status', 'status-color',
      'target-label', 'current-day', 'month-name', 'badge', 'daily-progress',
      'daily-tooltip-title', 'daily-tooltip', 'loading', 'segment-colors', 'segments',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    if (statCardSheet && 'adoptedStyleSheets' in this.shadowRoot) {
      this.shadowRoot.adoptedStyleSheets = [statCardSheet];
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
    this.updateAttribute(name, newValue);
  }

  updateAttribute(name, value) {
    const isLoading = this.hasAttribute('loading');
    switch (name) {
      case 'value': {
        if (isLoading) break;
        const valueEl = this.shadowRoot.querySelector('.value-text');
        if (valueEl) valueEl.textContent = value ?? '';
        break;
      }
      case 'color': {
        if (isLoading) break;
        const valueContainer = this.shadowRoot.querySelector('.value');
        if (valueContainer && !this.hasAttribute('status')) {
          valueContainer.style.color = value || '';
        }
        break;
      }
      case 'sub': {
        if (isLoading) {
          this.render();
          break;
        }
        const subTextEl = this.shadowRoot.querySelector('.sub-text');
        if (subTextEl) subTextEl.textContent = value ?? '';
        break;
      }
      case 'progress': {
        const progressBar = this.hasAttribute('segments') ? null : this.shadowRoot.querySelector('.progress-bar');
        if (this.hasAttribute('segments')) break;
        if (value == null || !progressBar) {
          this.render();
        } else {
          progressBar.style.width = `${value}%`;
        }
        break;
      }
      case 'progress-color': {
        if (!this.hasAttribute('segment-colors')) {
          for (const progBar of this.shadowRoot.querySelectorAll('.progress-bar')) {
            progBar.style.background = value || 'var(--color-green)';
          }
        }
        break;
      }
      case 'status-color': {
        const statusDot = this.shadowRoot.querySelector('.status-dot');
        if (statusDot) statusDot.style.background = value || 'var(--color-green)';
        break;
      }
      case 'title': {
        const titleEl = this.shadowRoot.querySelector('.title');
        if (titleEl) titleEl.textContent = value ?? '';
        break;
      }
      case 'icon': {
        const iconEl = this.shadowRoot.querySelector('.icon-wrapper i');
        if (iconEl) iconEl.className = formatIconClass(value);
        break;
      }
      case 'status':
      case 'target-label':
      case 'current-day':
      case 'month-name':
      case 'badge':
      case 'daily-progress':
      case 'daily-tooltip-title':
      case 'daily-tooltip':
      case 'loading':
      case 'segment-colors':
      case 'segments':
        this.render();
        break;
    }
  }

  render() {
    const title = this.getAttribute('title') || '';
    const icon = this.getAttribute('icon') || 'fa-circle';
    const value = this.getAttribute('value') || '';
    const sub = this.getAttribute('sub') || '';
    const color = this.getAttribute('color') || '';
    const progress = this.getAttribute('progress');
    const progressColor = this.getAttribute('progress-color') || 'var(--color-green)';
    const statusColor = this.getAttribute('status-color') || 'var(--color-green)';
    const badge = this.getAttribute('badge') || '';
    const targetLabel = this.getAttribute('target-label') || '';
    const currentDay = this.getAttribute('current-day') || '';
    const monthName = this.getAttribute('month-name') || '';
    const dailyProgress = this.getAttribute('daily-progress');
    const dailyTooltipTitle = this.getAttribute('daily-tooltip-title') || '';
    const dailyTooltip = this.getAttribute('daily-tooltip') || '';
    const captionParts = [targetLabel, currentDay && monthName ? `Day ${currentDay} of ${monthName}` : ''].filter(Boolean);
    const caption = captionParts.join(' · ');
    const hasStatus = this.hasAttribute('status');
    const hasProgress = this.hasAttribute('progress');
    // One piece of the bar per part, such as a volume: the widths are shares of the whole bar.
    const segments = (this.getAttribute('segments') || '')
      .split(',')
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0);
    const segmentColors = (this.getAttribute('segment-colors') || '')
      .split(/[,;](?![^(]*\))/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const valueStyle = color && !hasStatus && !this.hasAttribute('loading') ? `style="color: ${escapeHtml(color)}"` : '';
    const isLoading = this.hasAttribute('loading');
    this.toggleAttribute?.('aria-busy', isLoading);
    const subContent = escapeHtml(sub);
    const fallbackStyle = statCardSheet ? '' : `<style>${STAT_CARD_CSS}</style>`;

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/static/vendor/fontawesome/css/all.min.css?v=1">
      ${fallbackStyle}
      <div class="card" part="card">
        <div class="card-body">
          <div class="card-main">
            <div class="content">
              <div class="header">
                <span class="title">${escapeHtml(title)}</span>
                ${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ''}
              </div>
              <div class="value ${hasStatus ? 'status' : ''}" ${valueStyle}>
                ${hasStatus ? `<span class="status-dot" style="background: ${escapeHtml(statusColor)}"></span>` : ''}
                ${isLoading ? '<span class="stat-skeleton stat-skeleton-value" aria-hidden="true"></span>' : `<span class="value-text">${escapeHtml(value)}</span>`}
              </div>
            </div>
            <div class="visual">
              <slot name="visual"></slot>
              <div class="icon-wrapper${dailyProgress == null ? '' : ' daily-progress'}"${dailyProgress == null ? '' : ` style="--daily-progress: ${Number(dailyProgress) || 0}" data-tooltip-title="${escapeHtml(dailyTooltipTitle)}" data-tooltip="${escapeHtml(dailyTooltip)}" tabindex="0" aria-label="${escapeHtml(dailyTooltipTitle)}: ${escapeHtml(dailyTooltip)}"`}>
                <i class="${escapeHtml(formatIconClass(icon))}"></i>
              </div>
            </div>
          </div>
          <div class="sub" part="sub">
            <slot name="sub">${isLoading ? (subContent ? '<span class="stat-skeleton stat-skeleton-sub" aria-hidden="true"></span>' : '') : `<span class="sub-text">${subContent}</span>`}</slot>
          </div>
          <slot></slot>
        </div>
        ${
          hasProgress || caption
            ? `
        <div class="card-footer">
          ${
            hasProgress
              ? `<div class="progress${segments.length ? ' segmented' : ''}">${
                  segments.length
                    ? segments
                        .map((share, index) => {
                          const bg = segmentColors[index] || progressColor;
                          const opacity = segmentColors[index] ? 1 : index ? 0.55 : 1;
                          return `<div class="progress-bar" style="width: ${share}%; background: ${escapeHtml(bg)}; opacity: ${opacity}"></div>`;
                        })
                        .join('')
                    : `<div class="progress-bar" style="width: ${escapeHtml(progress)}%; background: ${escapeHtml(progressColor)}"></div>`
                }</div>`
              : ''
          }
          ${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}
        </div>
        `
            : ''
        }
      </div>
    `;
  }
}

if (!customElements.get('stat-card')) {
  customElements.define('stat-card', StatCard);
}

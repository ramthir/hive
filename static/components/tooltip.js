let tooltipId = 0;

class AppTooltip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          z-index: 11000;
          width: max-content;
          max-width: min(360px, calc(100vw - 24px));
          font-family: var(--font-family, Inter, system-ui, sans-serif);
          pointer-events: none;
          opacity: 0;
          transform: translateY(3px) scale(0.985);
          transform-origin: bottom center;
          transition: opacity 120ms ease-out, transform 120ms ease-out;
        }
        :host(.is-wide) {
          max-width: min(var(--tooltip-max-width, 640px), calc(100vw - 24px));
        }
        :host([data-placement="bottom"]) { transform-origin: top center; }
        :host(.is-visible) { opacity: 1; transform: translateY(0) scale(1); }
        :host([hidden]) { display: none; }
        .surface {
          position: relative;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          grid-template-areas:
            "title meta"
            "description description"
            "details details"
            "rationale rationale"
            "footer footer";
          box-sizing: border-box;
          width: max-content;
          max-width: min(360px, calc(100vw - 24px));
          padding: 12px 14px;
          color: var(--color-text);
          background: var(--color-dark1);
          border: 1px solid var(--color-dimmed5);
          border-radius: 10px;
          box-shadow: 0 14px 34px rgb(0 0 0 / 42%), 0 2px 8px rgb(0 0 0 / 24%);
        }
        :host(.is-wide) .surface {
          max-width: min(var(--tooltip-max-width, 640px), calc(100vw - 24px));
        }
        :host(.is-wide) .detail-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .surface::after {
          content: '';
          position: absolute;
          left: var(--tooltip-caret-left, 50%);
          width: 9px;
          height: 9px;
          background: var(--color-dark1);
          border-right: 1px solid var(--color-dimmed5);
          border-bottom: 1px solid var(--color-dimmed5);
          transform: translateX(-50%) rotate(45deg);
        }
        :host([data-placement="top"]) .surface::after { bottom: -5px; }
        :host([data-placement="bottom"]) .surface::after { top: -5px; transform: translateX(-50%) rotate(225deg); }
        .title { grid-area: title; color: var(--tooltip-title-color, var(--color-text)); font-size: 0.88rem; font-weight: var(--tooltip-title-weight, 650); line-height: 1.3; }
        .meta {
          grid-area: meta;
          justify-self: end;
          align-self: start;
          margin-left: 12px;
          padding: 2px 7px;
          color: var(--color-accent5);
          background: color-mix(in srgb, var(--color-accent5) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--color-accent5) 24%, transparent);
          border-radius: var(--radius-full, 9999px);
          font-size: 0.64rem;
          font-weight: 650;
          letter-spacing: 0.035em;
          line-height: 1.35;
          text-transform: uppercase;
        }
        .footer {
          grid-area: footer;
          align-self: center;
          margin-top: 10px;
          color: var(--color-dimmed2);
          font-size: 0.7rem;
          line-height: 1.35;
        }
        .description, .rationale { margin-top: 9px; color: var(--color-dimmed1); font-size: 0.78rem; line-height: 1.45; white-space: pre-line; }
        .description { grid-area: description; }
        .details {
          grid-area: details;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 5px 0;
          margin-top: 10px;
          color: var(--color-dimmed1);
          font-size: 0.76rem;
          line-height: 1.4;
        }
        .details[hidden] { display: none; }
        /* The last two rows read as a total unless the tooltip sets data-tooltip-no-total. */
        .details:not(.no-total) > :nth-last-child(-n + 2) {
          margin-top: 3px;
          padding-top: 7px;
          border-top: 1px solid var(--color-dimmed5);
        }
        .detail-dot { display: inline-block; width: 0.55rem; height: 0.55rem; margin-right: 7px; border-radius: var(--radius-full, 9999px); background: var(--detail-dot, var(--color-dimmed3)); vertical-align: baseline; }
        .detail-note { color: var(--color-dimmed2); }
        .detail-value {
          padding-left: 18px;
          color: var(--color-text);
          font-variant-numeric: tabular-nums;
          text-align: right;
          white-space: nowrap;
        }
        .checks {
          grid-area: details;
          display: grid;
          gap: 5px;
          margin-top: 10px;
          color: var(--color-dimmed1);
          font-size: 0.76rem;
          line-height: 1.4;
        }
        .checks[hidden] { display: none; }
        .check-row { display: grid; grid-template-columns: 1.1em minmax(0, 1fr); gap: 8px; align-items: baseline; }
        .check-mark { font-weight: 750; text-align: center; }
        .check-mark.approved { color: var(--color-state-pass); }
        .check-mark.rejected { color: var(--color-state-fail); }
        .check-mark.pending { color: var(--color-state-pending); }
        .check-mark.skipped { color: var(--color-state-skipped); }
        .rationale { grid-area: rationale; padding-top: 9px; border-top: 1px solid var(--color-dimmed5); }
        .rationale-label { display: block; margin-bottom: 3px; color: var(--color-accent6); font-size: 0.63rem; font-weight: 650; letter-spacing: 0.045em; text-transform: uppercase; }
        .rationale-text { color: var(--color-dimmed1); }
        @media (prefers-reduced-motion: reduce) { :host { transition: none; } }
      </style>
      <div class="surface">
        <div class="title"></div>
        <div class="meta"></div>
        <div class="description"></div>
        <div class="details"></div>
        <div class="checks" hidden></div>
        <div class="rationale"><span class="rationale-label">Why suggested</span><span class="rationale-text"></span></div>
        <div class="footer"></div>
      </div>
    `;
    this.hidden = true;
    this.id = `app-tooltip-${++tooltipId}`;
    this.setAttribute('role', 'tooltip');
  }

  set content(value) {
    const content = typeof value === 'string' ? { description: value } : value || {};
    const isWide = Boolean(content.wide);
    this.classList?.toggle('is-wide', isWide);
    if (isWide) {
      this.setAttribute?.('data-width', 'wide');
      if (content.maxWidth) this.style?.setProperty?.('--tooltip-max-width', content.maxWidth);
      else this.style?.removeProperty?.('--tooltip-max-width');
    } else {
      this.removeAttribute?.('data-width');
      this.style?.removeProperty?.('--tooltip-max-width');
    }
    this.style.setProperty('--tooltip-title-weight', content.plainTitle ? '400' : '650');
    // An optional accent for the title, reset for the next tooltip; only a design token reference is accepted.
    this.style.setProperty('--tooltip-title-color', /^var\(--[a-z0-9-]+\)$/.test(content.titleColor || '') ? content.titleColor : '');
    for (const field of ['title', 'meta', 'description', 'footer']) {
      const element = this.shadowRoot.querySelector(`.${field}`);
      element.textContent = content[field] || '';
      element.hidden = !content[field];
    }
    const details = this.shadowRoot.querySelector('.details');
    details.classList.toggle('no-total', Boolean(content.noTotal));
    const checks = this.shadowRoot.querySelector('.checks');
    const checkRows = Array.isArray(content.checks) ? content.checks : [];
    checks.replaceChildren();
    for (const check of checkRows) {
      const row = document.createElement('div');
      row.className = 'check-row';
      const mark = document.createElement('span');
      mark.className = `check-mark ${['approved', 'rejected', 'pending', 'skipped'].includes(check.tone) ? check.tone : 'pending'}`;
      mark.textContent = check.symbol || '○';
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = check.label || '';
      row.append(mark, label);
      checks.append(row);
    }
    checks.hidden = checkRows.length === 0;
    const detailRows = Array.isArray(content.details) ? content.details : [];
    details.replaceChildren();
    for (const detail of detailRows) {
      const label = document.createElement('span');
      label.className = 'detail-label';
      // An optional colour dot before the label; only a design token reference is accepted.
      if (/^var\(--[a-z0-9-]+\)$/.test(detail.color || '')) {
        const dot = document.createElement('span');
        dot.className = 'detail-dot';
        dot.style.setProperty('--detail-dot', detail.color);
        dot.setAttribute('aria-hidden', 'true');
        label.append(dot);
      }
      label.append(document.createTextNode(detail.label || ''));
      // An optional quieter note after the label, such as a reset time; plain text like the label.
      if (detail.note) {
        const note = document.createElement('span');
        note.className = 'detail-note';
        note.textContent = ` ${detail.note}`;
        label.append(note);
      }
      const detailValue = document.createElement('span');
      detailValue.className = 'detail-value';
      detailValue.textContent = detail.value || '';
      details.append(label, detailValue);
    }
    details.hidden = detailRows.length === 0;
    const rationale = this.shadowRoot.querySelector('.rationale');
    rationale.querySelector('.rationale-text').textContent = content.rationale || '';
    rationale.hidden = !content.rationale;
  }
}

if (!customElements.get('app-tooltip')) customElements.define('app-tooltip', AppTooltip);

class TooltipManager {
  constructor() {
    this.popup = new AppTooltip();
    this.target = null;
    this.previousDescription = null;
    this.bindings = new WeakMap();
    this.onPointerOver = (event) => this.showDelegated(event);
    this.onPointerMove = (event) => this.showDelegated(event);
    this.onPointerOut = (event) => this.hideDelegated(event);
    this.onFocusIn = (event) => this.showDelegated(event);
    this.onFocusOut = (event) => this.hideDelegated(event);
    this.onDismiss = () => this.hide();
    this.init();
  }

  init() {
    const start = () => {
      if (!this.popup.isConnected) document.body.append(this.popup);
      document.addEventListener('pointerover', this.onPointerOver, true);
      // Dynamic components can replace a hovered child during polling
      // without producing a new pointerover for the tooltip-bearing parent.
      // A delegated pointermove lets the tooltip recover on the next mouse
      // movement without attaching listeners to every refreshed element.
      document.addEventListener('pointermove', this.onPointerMove, true);
      document.addEventListener('pointerout', this.onPointerOut, true);
      document.addEventListener('focusin', this.onFocusIn, true);
      document.addEventListener('focusout', this.onFocusOut, true);
      document.addEventListener('pointerdown', this.onDismiss, true);
      document.addEventListener('scroll', this.onDismiss, true);
      // Scroll events do not bubble and may be contained by a component's
      // shadow root. Wheel and touchmove are composed, so they also dismiss
      // tooltips for nested dashboard scrollers before the target moves.
      document.addEventListener('wheel', this.onDismiss, { capture: true, passive: true });
      document.addEventListener('touchmove', this.onDismiss, { capture: true, passive: true });
      window.addEventListener('scroll', this.onDismiss, true);
      window.addEventListener('resize', this.onDismiss);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  eventTarget(event) {
    return event
      .composedPath()
      .find(
        (element) => element instanceof Element && (
          this.bindings.has(element)
          || element.hasAttribute('data-tooltip')
          || element.hasAttribute('data-tooltip-title')
        )
      );
  }

  contentFor(target) {
    const bound = this.bindings.get(target);
    if (bound) return typeof bound === 'function' ? bound(target) : bound;
      let details = [];
    try {
      const parsed = JSON.parse(target.dataset.tooltipDetails || '[]');
      if (Array.isArray(parsed)) details = parsed;
    } catch {
      // Ignore malformed optional detail data; the base tooltip still works.
    }
    return {
      title: target.dataset.tooltipTitle || '',
      wide: target.hasAttribute('data-tooltip-wide') || target.dataset.tooltipWidth === 'wide',
      maxWidth: target.dataset.tooltipMaxWidth || '',
      noTotal: target.hasAttribute('data-tooltip-no-total'),
      plainTitle: target.hasAttribute('data-tooltip-plain-title'),
      titleColor: target.dataset.tooltipTitleColor || '',
      meta: target.dataset.tooltipMeta || '',
      description: target.dataset.tooltip || '',
      rationale: target.dataset.tooltipRationale || '',
      footer: target.dataset.tooltipFooter || '',
      details,
      checks: (() => {
        try {
          const parsed = JSON.parse(target.dataset.tooltipChecks || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    };
  }

  showDelegated(event) {
    const target = this.eventTarget(event);
    // Pointer-out can be skipped when a polling render replaces the hovered
    // target. Treat movement over a non-tooltip element as an authoritative
    // leave so a detached or previously focused target cannot stay visible.
    if (!target && event.type === 'pointermove') {
      this.hide();
      return;
    }
    if (target && (target !== this.target || this.popup.hidden)) {
      this.show(target, this.contentFor(target));
    }
  }

  hideDelegated(event) {
    const target = this.eventTarget(event);
    if (!target || target !== this.target) return;
    const next = event.relatedTarget;
    if (next instanceof Node && target.contains(next)) return;
    this.hide(target);
  }

  bind(target, content) {
    this.bindings.set(target, content);
    const resolveContent = () => (typeof content === 'function' ? content(target) : content);
    const show = () => this.show(target, resolveContent());
    const leave = () => {
      if (target.getRootNode().activeElement !== target) this.hide(target);
    };
    const blur = () => this.hide(target);
    target.addEventListener('mouseenter', show);
    target.addEventListener('mouseleave', leave);
    target.addEventListener('focus', show);
    target.addEventListener('blur', blur);
    return () => {
      if (this.target === target) this.hide(target);
      this.bindings.delete(target);
      target.removeEventListener('mouseenter', show);
      target.removeEventListener('mouseleave', leave);
      target.removeEventListener('focus', show);
      target.removeEventListener('blur', blur);
    };
  }

  show(target, content) {
    if (!target?.isConnected || !content) return;
    this.restoreDescription();
    this.target = target;
    this.previousDescription = target.getAttribute('aria-description');
    this.popup.content = content;
    const detailText = (content.details || []).map((detail) => `${detail.label}: ${detail.value}`).join('. ');
    const accessibleText = [content.title, content.meta, content.description, detailText, content.rationale, content.footer]
      .filter(Boolean)
      .join('. ');
    if (accessibleText) target.setAttribute('aria-description', accessibleText);
    this.popup.hidden = false;
    this.popup.classList.remove('is-visible');

    // An optional element inside the target to place the tooltip against, such as the top of a bar.
    const anchor = (target.dataset.tooltipAnchor && target.querySelector(target.dataset.tooltipAnchor)) || target;
    const targetRect = anchor.getBoundingClientRect();
    const tooltipRect = this.popup.getBoundingClientRect();
    const margin = 12;
    const gap = 9;
    const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
    const left = Math.min(maxLeft, Math.max(margin, targetRect.left + (targetRect.width - tooltipRect.width) / 2));
    const preferredTop = targetRect.top - tooltipRect.height - gap;
    const maxTop = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
    const placement = preferredTop >= margin ? 'top' : 'bottom';
    const top = Math.min(maxTop, Math.max(margin, placement === 'top' ? preferredTop : targetRect.bottom + gap));
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
    this.popup.dataset.placement = placement;
    const targetCenter = targetRect.left + targetRect.width / 2;
    const caretLeft = Math.min(tooltipRect.width - 14, Math.max(14, targetCenter - left));
    this.popup.style.setProperty('--tooltip-caret-left', `${caretLeft}px`);
    requestAnimationFrame(() => {
      if (!this.popup.hidden && this.target === target) this.popup.classList.add('is-visible');
    });
  }

  restoreDescription() {
    if (!this.target) return;
    if (this.previousDescription === null) this.target.removeAttribute('aria-description');
    else this.target.setAttribute('aria-description', this.previousDescription);
  }

  hide(target = null) {
    if (target && target !== this.target) return;
    this.restoreDescription();
    this.target = null;
    this.previousDescription = null;
    this.popup.classList.remove('is-visible');
    this.popup.hidden = true;
  }

  // Dynamic components frequently replace tooltip targets during polling.
  // Clear a detached target so the next pointer/focus event can bind to the
  // newly-rendered element instead of retaining a stale reference.
  reconcile() {
    if (this.target && !this.target.isConnected) this.hide();
  }
}

export const tooltip = new TooltipManager();
export { AppTooltip, TooltipManager };

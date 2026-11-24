import { renderPageHeader, renderBreadcrumbTrail, renderBackLink, isRedundantBreadcrumb } from './components/page-header.js';

/*
 * The component's CSS, parsed once and shared by every header on the page (adoptedStyleSheets),
 * instead of a copy of the stylesheet in each shadow root. FontAwesome stays a <link> in each
 * root: a shadow root cannot see the document's icon classes, and @font-face rules adopted into
 * a shadow root are ignored, so the root needs its own link (the browser cache serves one file).
 */
const COMPONENT_CSS = `
                :host {
                    display: block;
                }

                .page-header-content {
                    display: flex;
                    flex-direction: column;
                    align-items: stretch;
                    min-height: 4.5625rem;
                    gap: 1rem;
                    margin: calc(-1 * var(--page-block-padding)) calc(-1 * var(--page-inline-padding)) 0;
                    padding: 1rem var(--page-inline-padding);
                    border-bottom: 1px solid var(--color-dimmed5);
                    margin-bottom: 1.5rem;
                }

                /* Layout variants. A page picks one with variant="…" instead of overriding CSS
                   variables, and adds attached to remove the gap below the header. */

                /* flush: the page has no padding of its own, so the header sits flush and pads itself. */
                :host([variant="flush"]) .page-header-content {
                    margin-top: 0;
                    margin-inline: 0;
                    padding: 1rem var(--space-6);
                }


                /* bar: a compact bar that sits flush at the top of its pane, with no gap below. */
                :host([variant="bar"]) .page-header-content {
                    margin-top: 0;
                    margin-inline: 0;
                    margin-bottom: 0;
                    padding: 0.75rem var(--page-inline-padding, 1.5rem);
                }

                /* edge: the page widens the host to its edges itself, so the header only pulls up
                   into the top padding; its actions wrap. */
                :host([variant="edge"]) .page-header-content {
                    margin-top: calc(-1 * var(--page-block-padding, 1.25rem));
                    margin-inline: 0;
                }

                :host([variant="edge"]) .page-header-actions {
                    flex-wrap: wrap;
                }

                /* bottom: for a header whose heading block has a second line (chips under the heading). The heading stays
                   where it is in a header without one (the min-height is the usual 4.5625rem plus that line), the second
                   line ends just above the bottom border, the actions keep to the middle, and the search box is shorter
                   so the chips have room. */
                :host([bottom]) {
                    --search-width: var(--search-width-compact, 20rem);
                }

                :host([bottom]) .page-header-content {
                    align-items: flex-end;
                    min-height: 5.0625rem;
                    padding-bottom: 0.5rem;
                }

                :host([bottom]) .page-header-actions {
                    align-self: center;
                }

                /* attached: no gap between the header and the content below it. */
                :host([attached]) .page-header-content {
                    margin-bottom: 0;
                }

                .page-header-content {
                    flex-direction: row;
                    align-items: center;
                    justify-content: space-between;
                }
            

                .page-header-title {
                    min-width: 0;
                    flex: 1;
                }

                .page-header-meta:empty {
                    display: none;
                }

                .page-header-eyebrow {
                    margin-bottom: 0.2rem;
                }

                .page-header-breadcrumb {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    color: var(--color-dimmed2);
                    font-size: 0.72rem;
                    font-weight: 600;
                }

                .page-header-breadcrumb a,
                .page-header-crumb,
                .back-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    color: inherit;
                    text-decoration: none;
                }

                .back-link {
                    color: var(--color-dimmed2, #939293);
                    font-size: 0.8rem;
                    font-weight: 600;
                }

                .back-link:hover {
                    color: var(--color-text, #fcfcfa);
                }

                .page-header-meta {
                    margin-top: var(--space-3, 0.75rem);
                }

                .page-title {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--color-text, #fcfcfa);
                    margin: 0.15rem 0 0;
                    font-family: var(--font-family, -apple-system, sans-serif);
                }

                .page-title {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
            

                ::slotted([slot="title"]) {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--color-text, #fcfcfa);
                    margin: 0.15rem 0 0;
                    font-family: var(--font-family, -apple-system, sans-serif);
                }

                .page-subtitle {
                    margin: 0.2rem 0 0;
                    font-size: 0.9rem;
                    font-weight: 500;
                    color: var(--color-dimmed2, #939293);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-family: var(--font-family, -apple-system, sans-serif);
                }

                .page-subtitle:empty {
                    display: none;
                }

                ::slotted([slot="subtitle"]) {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.375rem;
                    align-items: center;
                    margin-top: 0.3rem;
                }

                .page-header-actions {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    width: 100%;
                    gap: var(--app-header-action-gap, var(--space-3, 0.75rem));
                }

                .page-header-actions {
                    flex-wrap: nowrap;
                    width: auto;
                }
            

                .page-header-actions:empty {
                    display: none;
                }

                /* Slotted button styles — the same --btn-header-* scale
                   chat-service's own header buttons use, so an
                   app-header "actions" button looks identical regardless
                   of which portal renders it. */
                ::slotted([slot="actions"]:not(app-tab-bar):not(.app-header-action-group)) {
                    display: inline-flex;
                    align-items: center;
                    height: var(--btn-header-height, 2.8125rem);
                    padding: 0 var(--btn-header-padding-x, 0.85rem);
                    border-radius: var(--btn-header-radius, 8px);
                    font-size: var(--btn-header-font-size, 0.8rem);
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
                    font-family: var(--font-family, -apple-system, sans-serif);
                    box-sizing: border-box;
                }

                ::slotted([slot="actions"].app-header-action-group) {
                    height: auto;
                    padding: 0;
                    border-radius: 0;
                    border: none;
                }

                ::slotted(button[slot="actions"]) {
                    border: var(--btn-header-secondary-border, 1px solid var(--color-dimmed5));
                }

                ::slotted(.btn-secondary) {
                    background: var(--btn-header-secondary-bg, var(--color-dark2, #19181a));
                    border: var(--btn-header-secondary-border, 1px solid var(--color-dimmed5, #403e41));
                    color: var(--btn-header-secondary-text, var(--color-text, #fcfcfa));
                }

                ::slotted(.btn-secondary:hover) {
                    background: var(--btn-header-secondary-hover-bg, var(--color-dimmed5, #403e41));
                    border-color: var(--btn-header-secondary-border-hover, var(--color-dimmed4, #5b595c));
                }

                ::slotted(.btn-primary) {
                    background: var(--btn-header-primary-bg, var(--color-accent5, #78dce8));
                    border: var(--btn-header-primary-border, 1px solid var(--color-dimmed5, #403e41));
                    color: var(--btn-header-primary-text, var(--color-dark1, #221f22));
                }

                ::slotted(.btn-primary:hover) {
                    background: var(--btn-header-primary-hover-bg, var(--color-primary-hover, #5bc4d0));
                    border-color: var(--btn-header-primary-border-hover, var(--color-dimmed4, #5b595c));
                }

                ::slotted(.btn-danger),
                ::slotted(.danger) {
                    background: var(--btn-header-danger-bg, rgba(255, 97, 174, 0.1));
                    border: var(--btn-header-danger-border, 1px solid rgba(255, 97, 174, 0.3));
                    color: var(--btn-header-danger-text, var(--color-accent1, #ff6188));
                }

                ::slotted(.btn-danger:hover),
                ::slotted(.danger:hover) {
                    background: var(--btn-header-danger-hover-bg, rgba(255, 97, 174, 0.2));
                    border-color: var(--btn-header-danger-border-hover, #ff6188);
                }
`;

let sharedSheet;

function componentSheet() {
  if (sharedSheet === undefined) {
    try {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(COMPONENT_CSS);
    } catch {
      sharedSheet = null; // no constructable stylesheets: each root gets its own <style>
    }
  }
  return sharedSheet;
}

function applyComponentStyles(root) {
  root.innerHTML = '<link rel="stylesheet" href="/static/vendor/fontawesome/css/all.min.css?v=1">';
  const sheet = componentSheet();
  if (sheet && 'adoptedStyleSheets' in root) {
    root.adoptedStyleSheets = [sheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = COMPONENT_CSS;
  root.append(style);
}

/**
 * App Header Web Component
 * A flexible header with a heading, an optional subtitle, and optional actions.
 * The heading is its own attribute (not `title`) so the host never carries a `title`
 * and the browser shows no native tooltip over the header.
 *
 * Usage:
 *   <app-header heading="Dashboard" subtitle="Active conversation name">
 *       <button slot="actions" class="btn-primary">Publish</button>
 *   </app-header>
 *
 * Layout (all optional):
 *   variant="flush"  no bleed into the page padding; pads itself (Notes, Assets)
 *   variant="bar"    compact bar flush at the top of its pane, no gap below (Decide)
 *   variant="edge"   the page widens the host itself; the header only pulls up, actions wrap (Chat)
 *   bottom           a line under the heading sits just above the bottom border, the heading stays put (Specifications)
 *   attached         no gap below the header
 */
class AppHeader extends HTMLElement {
  static get observedAttributes() {
    return ['heading', 'subtitle'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    applyComponentStyles(this.shadowRoot);
    this._breadcrumbs = [];
    this._backLink = null;
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'heading') {
      const titleEl = this.shadowRoot.querySelector('.page-title');
      if (titleEl) titleEl.textContent = newValue || '';
    } else if (name === 'subtitle') {
      const subtitleEl = this.shadowRoot.querySelector('.page-subtitle');
      if (subtitleEl) subtitleEl.textContent = newValue || '';
    }
  }

  get heading() {
    return this.getAttribute('heading') || '';
  }

  set heading(value) {
    if (value === null || value === undefined) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  get variant() {
    return this.getAttribute('variant') || '';
  }

  set variant(value) {
    if (value === null || value === undefined || value === '') this.removeAttribute('variant');
    else this.setAttribute('variant', value);
  }

  get attached() {
    return this.hasAttribute('attached');
  }

  set attached(value) {
    this.toggleAttribute('attached', Boolean(value));
  }

  get subtitle() {
    return this.getAttribute('subtitle') || '';
  }

  get breadcrumbs() {
    return this._breadcrumbs;
  }

  set breadcrumbs(value) {
    const next = Array.isArray(value) ? value : [];
    if (JSON.stringify(next) === JSON.stringify(this._breadcrumbs)) return;
    this._breadcrumbs = next;
    if (this.isConnected) this.updateBreadcrumbs();
  }

  get backLink() {
    return this._backLink;
  }

  set backLink(value) {
    const next = value || null;
    if (JSON.stringify(next) === JSON.stringify(this._backLink)) return;
    this._backLink = next;
    if (this.isConnected) this.updateActions();
  }

  render() {
    this.shadowRoot.querySelector('header')?.remove();
    const markup = document.createElement('template');
    markup.innerHTML = renderPageHeader({
      title: this.heading,
      subtitle: this.subtitle,
      breadcrumbs: this.breadcrumbs,
      backLink: this.backLink,
    });
    this.shadowRoot.append(markup.content);

    this.shadowRoot.querySelectorAll('slot[name="meta"]').forEach((slot) => {
      const syncVisibility = () => {
        slot.parentElement.hidden = slot.assignedNodes().length === 0;
      };
      slot.addEventListener('slotchange', syncVisibility);
      syncVisibility();
    });

    this.shadowRoot.querySelectorAll('slot[name="eyebrow"]').forEach((slot) => {
      slot.addEventListener('slotchange', () => this.syncEyebrowVisibility());
    });
    this.syncEyebrowVisibility();
  }

  // Breadcrumbs and the back link change while the page is open (Notes, Chat, Assets), so they
  // patch only their own part: the header, its slotted children and its listeners stay in place.
  updateBreadcrumbs() {
    const slot = this.shadowRoot.querySelector('slot[name="eyebrow"]');
    if (!slot) {
      this.render();
      return;
    }
    slot.innerHTML = renderBreadcrumbTrail(this.breadcrumbs);
    this.syncEyebrowVisibility();
  }

  updateActions() {
    const actions = this.shadowRoot.querySelector('.page-header-actions');
    if (!actions) {
      this.render();
      return;
    }
    actions.innerHTML = this.backLink ? renderBackLink(this.backLink) : '<slot name="actions"></slot>';
  }

  syncEyebrowVisibility() {
    this.shadowRoot?.querySelectorAll('slot[name="eyebrow"]').forEach((slot) => {
      const showBreadcrumbs = this.breadcrumbs.length > 0 && !isRedundantBreadcrumb(this.breadcrumbs);
      if (slot.parentElement) {
        slot.parentElement.hidden = !showBreadcrumbs && slot.assignedNodes().length === 0;
      }
    });
  }
}

customElements.define('app-header', AppHeader);

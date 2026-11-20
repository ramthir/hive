const STYLESHEET_HREF = '/static/components/action-toolbar.css?v=8';
const STYLESHEET_KEY = 'action-toolbar.css';

/**
 * Class list an action bar carries. Kept as a pure function so the layout contract
 * (base container plus an optional fixed modifier) is testable without a DOM.
 */
export function actionBarClasses({ fixed = false } = {}) {
  return fixed ? ['app-action-bar', 'app-action-bar--fixed'] : ['app-action-bar'];
}

/**
 * Make sure the stylesheet that styles the bar is available in the tree the bar lives in:
 * the document head for light DOM, or the shadow root that contains it (document styles do
 * not reach into shadow roots). A link the page already added is reused, not duplicated.
 */
export function ensureActionBarStylesheet(root, doc = globalThis.document) {
  const scope = root && typeof root.querySelector === 'function' && root !== doc ? root : doc;
  if (!scope || typeof scope.querySelector !== 'function') return null;
  const existing = scope.querySelector(`link[href*="${STYLESHEET_KEY}"]`);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  (scope === doc ? doc.head : scope).appendChild(link);
  return link;
}

/**
 * Bottom action bar shared by Notes, Decide and Transcribes.
 *
 * Usage:
 *   <app-action-bar fixed aria-label="Note status and actions">
 *     <div class="action-bar-left">status, stats…</div>
 *     <div class="action-bar-right"><button class="tool-button">Save</button></div>
 *   </app-action-bar>
 *
 * Attributes:
 *   fixed  pin the bar to the bottom of the viewport, clear of the sidebar (default: in flow)
 *
 * The bar stays light DOM so page code keeps querying and updating its children directly.
 * It owns the container classes and loads its own stylesheet, so a page cannot forget either.
 */
export class AppActionBar extends HTMLElement {
  static get observedAttributes() {
    return ['fixed'];
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'group');
    this.syncClasses();
    ensureActionBarStylesheet(this.getRootNode?.());
  }

  attributeChangedCallback() {
    if (this.isConnected) this.syncClasses();
  }

  get fixed() {
    return this.hasAttribute('fixed');
  }

  set fixed(value) {
    this.toggleAttribute('fixed', Boolean(value));
  }

  syncClasses() {
    this.classList.add('app-action-bar');
    this.classList.toggle('app-action-bar--fixed', this.fixed);
  }
}

if (!customElements.get('app-action-bar')) customElements.define('app-action-bar', AppActionBar);

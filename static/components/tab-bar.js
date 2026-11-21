const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// Load tab-bar CSS if not already loaded
if (!document.querySelector('link[href*="tab-bar.css"]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/static/components/tab-bar.css?v=5';
  document.head.appendChild(link);
}

// Shared segmented tab-bar component used by service headers.
class AppTabBar extends HTMLElement {
  constructor() {
    super();
    this._tabs = {};
    this._active = '';
  }
  connectedCallback() {
    this.classList.add('tab-bar');
    this.setAttribute('role', 'tablist');
    this.addEventListener('click', this._click);
    this.addEventListener('keydown', this._keydown);
    this.render();
  }
  disconnectedCallback() {
    this.removeEventListener('click', this._click);
    this.removeEventListener('keydown', this._keydown);
  }
  // Arrow keys, Home and End move to a tab and switch to it (roving tabindex: only the active tab is tabbable).
  _keydown = (event) => {
    const keys = Object.keys(this._tabs);
    const at = keys.indexOf(this._active);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[event.key];
    if (to === undefined || !keys.length) return;
    event.preventDefault();
    const key = keys[(to + keys.length) % keys.length];
    this.active = key;
    this.querySelector(`[data-tab="${CSS.escape(key)}"]`)?.focus();
    this.dispatchEvent(new CustomEvent('tab-switch', { detail: { tab: key }, bubbles: true }));
  };
  _click = (event) => {
    const key = event.target.closest('[data-tab]')?.dataset.tab;
    if (!key || key === this._active || !this._tabs[key]) return;
    this.active = key;
    this.dispatchEvent(new CustomEvent('tab-switch', { detail: { tab: key }, bubbles: true }));
  };
  set tabs(value) {
    this._tabs = value || {};
    this.render();
  }
  set active(value) {
    this._active = value || '';
    this.sync();
  }
  get active() {
    return this._active;
  }
  sync() {
    this.querySelectorAll('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === this._active;
      button.classList.toggle('tab-bar-item--active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }
  render() {
    if (!this.isConnected) return;
    this.innerHTML = Object.entries(this._tabs)
      .map(
        ([key, tab]) =>
          `<button type="button" class="tab-bar-item" data-tab="${escapeHtml(key)}" role="tab">${tab.icon ? `<i class="${escapeHtml(tab.icon)}" aria-hidden="true" style="margin-right: 6px;"></i>` : ''}${escapeHtml(tab.label)}</button>`
      )
      .join('');
    this.sync();
  }
}
customElements.define('app-tab-bar', AppTabBar);

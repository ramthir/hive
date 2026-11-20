let dropdownId = 0;

/**
 * <app-dropdown-menu placement="top-end|bottom-end|bottom-start|top-start">
 *
 * Slots / Elements:
 *   [slot="trigger"] - The interactive trigger element (button, icon, etc.)
 *   [slot="menu"] or direct buttons - The items inside the popup
 *
 * Dispatches:
 *   'dropdown-select' event with { detail: { action, item, event } } when an item is clicked
 */
export class AppDropdownMenu extends HTMLElement {
  static get observedAttributes() {
    return ['placement', 'disabled'];
  }

  constructor() {
    super();
    this._id = `app-dropdown-${++dropdownId}`;
    this.open = false;

    this._onDocClick = (e) => {
      if (!e.composedPath().includes(this)) {
        this.close();
      }
    };

    this._onDocKeyDown = (e) => {
      if (e.key === 'Escape' && this.open) {
        e.stopPropagation();
        this.close();
        this.trigger?.focus();
      }
    };
  }

  get placement() {
    return this.getAttribute('placement') || 'bottom-start';
  }

  set placement(val) {
    if (val) this.setAttribute('placement', val);
    else this.removeAttribute('placement');
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(val) {
    if (val) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  connectedCallback() {
    this.init();
    document.addEventListener('click', this._onDocClick);
    document.addEventListener('keydown', this._onDocKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('keydown', this._onDocKeyDown);
  }

  attributeChangedCallback(name, _old, value) {
    if (name === 'placement' && this.popup) {
      this.popup.setAttribute('data-placement', value || 'bottom-start');
    }
  }

  init() {
    this.trigger = this.querySelector('[slot="trigger"]') || this.firstElementChild;
    this.popup = this.querySelector('.app-dropdown-popup, [slot="menu"]');

    if (!this.trigger) return;

    this.trigger.setAttribute('aria-haspopup', 'menu');
    this.trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');

    if (this.popup) {
      if (!this.popup.classList.contains('app-dropdown-popup')) {
        this.popup.classList.add('app-dropdown-popup');
      }
      this.popup.setAttribute('role', 'menu');
      this.popup.setAttribute('data-placement', this.placement);
      if (!this.open) {
        this.popup.hidden = true;
      }
    }

    this.trigger.onclick = (e) => {
      if (this.disabled) return;
      e.stopPropagation();
      this.toggle();
    };

    this.setupItemListeners();
  }

  setupItemListeners() {
    if (!this.popup) return;
    this.popup.onclick = (e) => {
      const item = e.target.closest('button, [role="menuitem"], .app-dropdown-item, .notes-menu-item');
      if (!item || item.disabled) return;
      e.stopPropagation();
      const action = item.getAttribute('data-action') || item.getAttribute('data-download-theme') || item.dataset.action;
      this.dispatchEvent(
        new CustomEvent('dropdown-select', {
          bubbles: true,
          composed: true,
          detail: { action, item, originalEvent: e },
        })
      );
      this.close();
    };
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.disabled || !this.popup) return;
    this.popup.hidden = false;
    this.open = true;
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.dispatchEvent(new CustomEvent('dropdown-open', { bubbles: true, composed: true }));
  }

  close() {
    if (!this.open || !this.popup) return;
    this.popup.hidden = true;
    this.open = false;
    this.trigger?.setAttribute('aria-expanded', 'false');
    this.dispatchEvent(new CustomEvent('dropdown-close', { bubbles: true, composed: true }));
  }
}

if (!customElements.get('app-dropdown-menu')) {
  customElements.define('app-dropdown-menu', AppDropdownMenu);
}

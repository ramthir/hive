const focusable =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),app-combobox:not([disabled]),app-datepicker:not([disabled]),[tabindex]:not([tabindex="-1"])';
const openDialogs = [];

class AppDialog extends HTMLElement {
  constructor() {
    super();
    this._open = false;
    this._closingTimer = null;
    this._busy = false;
    this._requestingClose = false;
    this.closeOnBackdrop = true;
    this.initialFocus = null;
    this._click = (event) => {
      if (event.target.closest('[data-dialog-close]')) this.requestClose('close-button');
      else if (this.closeOnBackdrop && event.target === this) this.requestClose('backdrop');
    };
    this._keydown = (event) => this.handleKeydown(event);
  }
  connectedCallback() {
    this.addEventListener('click', this._click);
  }
  disconnectedCallback() {
    this.destroy();
  }
  elements() {
    return [...this.querySelectorAll(focusable)].filter(
      (element) => !element.closest('[hidden]') && element.getClientRects().length
    );
  }
  open(options = {}) {
    if (this._open) return false;
    clearTimeout(this._closingTimer);
    this._closingTimer = null;
    this.classList.remove('is-closing');
    this._open = true;
    this._returnFocus = document.activeElement;
    this._onClose = options.onClose;
    this._beforeClose = options.beforeClose;
    this.classList.remove('is-hidden');
    this.inertOutside();
    openDialogs.push(this);
    document.body.classList.add('dialog-open');
    document.addEventListener('keydown', this._keydown, true);
    requestAnimationFrame(() => {
      const target =
        (typeof this.initialFocus === 'string' ? this.querySelector(this.initialFocus) : this.initialFocus) ||
        this.elements()[0] ||
        this.querySelector('.modal-panel');
      target?.focus({ preventScroll: true });
    });
    return true;
  }
  close(reason = 'close') {
    if (!this._open || this._busy) return false;
    this._open = false;
    document.removeEventListener('keydown', this._keydown, true);
    const index = openDialogs.lastIndexOf(this);
    if (index >= 0) openDialogs.splice(index, 1);
    if (!openDialogs.length) document.body.classList.remove('dialog-open');
    this._restoreOutside?.();
    this._restoreOutside = null;
    const focus = this._returnFocus,
      callback = this._onClose;
    this._returnFocus = null;
    this._onClose = null;
    this._beforeClose = null;
    const finish = () => {
      this._closingTimer = null;
      this.classList.remove('is-closing');
      this.classList.add('is-hidden');
    };
    if (this.querySelector('.modal-panel--drawer')) {
      this.classList.add('is-closing');
      this._closingTimer = setTimeout(finish, 200);
    } else {
      finish();
    }
    callback?.(reason);
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    return true;
  }
  async requestClose(reason) {
    if (!this._open || this._busy || this._requestingClose) return false;
    this._requestingClose = true;
    try {
      if (this._beforeClose && (await this._beforeClose(reason)) === false) return false;
      return this.close(reason);
    } finally {
      this._requestingClose = false;
    }
  }
  setBusy(busy) {
    this._busy = Boolean(busy);
    this.setAttribute('aria-busy', String(this._busy));
    this.querySelectorAll('[data-dialog-close]').forEach((button) => (button.disabled = this._busy));
  }
  isOpen() {
    return this._open;
  }
  handleKeydown(event) {
    if (!this._open || openDialogs.at(-1) !== this) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.requestClose('escape');
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = this.elements();
    if (!elements.length) {
      event.preventDefault();
      return;
    }
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  inertOutside() {
    const states = [];
    let branch = this;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch) continue;
        states.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
      branch = parent;
    }
    this._restoreOutside = () => states.forEach(([element, inert]) => (element.inert = inert));
  }
  destroy() {
    if (this._open) {
      this._busy = false;
      this.close('destroy');
    }
    this.removeEventListener('click', this._click);
    document.removeEventListener('keydown', this._keydown, true);
  }
}
customElements.define('app-dialog', AppDialog);

export function createDialog(element, { initialFocus = null, closeOnBackdrop = true } = {}) {
  if (!element) throw new Error('Dialog element is required.');
  element.initialFocus = initialFocus;
  element.closeOnBackdrop = closeOnBackdrop;
  return {
    open: (options) => element.open(options),
    close: (reason) => element.close(reason),
    requestClose: (reason) => element.requestClose(reason),
    setBusy: (busy) => element.setBusy(busy),
    isOpen: () => element.isOpen(),
    destroy: () => element.destroy(),
  };
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function confirmDialog({
  title = 'Confirm',
  message = 'Are you sure?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  icon = 'fa-triangle-exclamation',
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('app-dialog');
    dialog.className = 'modal-backdrop is-hidden confirm-dialog-host';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-message');
    dialog.innerHTML = `
      <div class="modal-panel modal-panel--alert" tabindex="-1">
        <div class="modal-header">
          <h2 class="modal-title" id="confirm-dialog-title">${esc(title)}</h2>
          <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="modal-body modal-alert-body" id="confirm-dialog-message">
          <i class="fa-solid ${esc(icon)}" aria-hidden="true"></i>
          <span>${esc(message)}</span>
        </div>
        <div class="modal-footer">
          <button type="button" class="crud-drawer-btn" data-action="cancel">${esc(cancelText)}</button>
          <button type="button" class="crud-drawer-btn${danger ? ' danger' : ' primary'}" data-action="confirm">${esc(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const controller = createDialog(dialog, {
      initialFocus: '[data-action="cancel"]',
      closeOnBackdrop: false,
    });
    let resolved = false;
    const finish = (confirmed) => {
      if (resolved) return;
      resolved = true;
      controller.close();
      setTimeout(() => {
        if (dialog.isConnected) dialog.remove();
      }, 220);
      resolve(confirmed);
    };
    dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => finish(true));
    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => finish(false));
    dialog.querySelector('[data-dialog-close]')?.addEventListener('click', () => finish(false));
    controller.open({
      onClose: () => {
        if (!resolved) finish(false);
      },
    });
  });
}

export function confirmDiscard(options = {}) {
  return confirmDialog({
    title: 'Unsaved changes',
    message: 'You have unsaved changes. Are you sure you want to discard them?',
    confirmText: 'Discard',
    cancelText: 'Cancel',
    danger: true,
    icon: 'fa-triangle-exclamation',
    ...options,
  });
}

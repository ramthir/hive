import { createDialog } from '/static/components/dialog.js';
import { escapeHtml as esc } from '/static/html.js';

/** Open a modal built from `innerHtml`. Returns `{ dialog, close }`; `[data-action="cancel"]` buttons ask to close it. */
export function openDialog(innerHtml, { className = '', initialFocus = null, wide = false, beforeClose = null } = {}) {
  const dialog = document.createElement('app-dialog');
  dialog.className = `modal-backdrop is-hidden ${className}`;
  dialog.innerHTML = `<div class="modal-panel${wide ? ' modal-panel--drawer modal-panel--drawer-wide' : ''}" tabindex="-1">${innerHtml}</div>`;
  document.body.appendChild(dialog);
  const controller = createDialog(dialog, { closeOnBackdrop: true, initialFocus });
  const close = () => {
    controller.close();
    setTimeout(() => dialog.remove(), 220);
  };
  controller.open({ onClose: () => setTimeout(() => dialog.remove(), 220), beforeClose });
  // Cancel, Esc, the X and the backdrop ask `beforeClose` (it may return false to keep the dialog); `close` does not.
  dialog.querySelectorAll('[data-action="cancel"]').forEach((el) => el.addEventListener('click', () => controller.requestClose('cancel')));
  return { dialog, close };
}

export const dialogHeader = (title) => `
  <div class="modal-header">
    <h2 class="modal-title">${esc(title)}</h2>
    <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
  </div>`;

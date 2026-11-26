import { confirmDialog, createDialog } from '/static/components/dialog.js';
import { escapeHtml as esc } from '/static/html.js';
import { api } from '/static/notes/api.js';

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

export function showAlertDialog(title, message) {
  const { dialog } = openDialog(`
    ${dialogHeader(title)}
    <div class="modal-body modal-alert-body"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(message || 'Something went wrong.')}</span></div>
    <div class="modal-footer"><button type="button" class="crud-drawer-btn primary" data-dialog-close>Close</button></div>`,
  { className: 'notes-save-error-dialog-host', initialFocus: '.modal-footer [data-dialog-close]' });
  dialog.setAttribute('role', 'alertdialog');
  return dialog;
}

/**
 * Confirm and delete `note`. Refuses with a list of linking notes when backlinks exist so the user can remove links first.
 */
export async function confirmAndDeleteNote(note, { onDeleted, onError } = {}) {
  if (!note?.slug) return;
  const linking = await api(`/notes/${encodeURIComponent(note.slug)}/backlinks`).then(
    (data) => data.backlinks.filter((other) => other.slug !== note.slug),
    () => [],
  );
  if (linking.length) {
    const items = linking.map((other) => `<li><a class="notes-wikilink" href="/notes/${esc(encodeURIComponent(other.slug))}" data-route>${esc(other.title)}</a></li>`).join('');
    const { dialog, close } = openDialog(`
      ${dialogHeader('Cannot Delete Note')}
      <div class="modal-body modal-alert-body"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>"${esc(note.title)}" is linked from ${linking.length === 1 ? '1 other note' : `${linking.length} other notes`}. Open ${linking.length === 1 ? 'it' : 'them'} and remove the link before deleting.<ul class="confirm-dialog-details" id="linked-notes">${items}</ul></span></div>
      <div class="modal-footer"><button type="button" class="crud-drawer-btn primary" data-dialog-close>Close</button></div>`,
    { className: 'notes-save-error-dialog-host', initialFocus: '.modal-footer [data-dialog-close]' });
    dialog.setAttribute('role', 'alertdialog');
    dialog.querySelectorAll('#linked-notes a').forEach((a) => a.addEventListener('click', close));
    return;
  }
  const confirmed = await confirmDialog({
    title: 'Delete Note?',
    message: `Delete "${note.title}"? The file is removed and the deletion is committed; you can recover it from git history.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api(`/notes/${encodeURIComponent(note.slug)}`, { method: 'DELETE' });
    onDeleted?.();
  } catch (error) {
    if (onError) onError(error);
    else showAlertDialog('Could Not Delete Note', error.message);
  }
}

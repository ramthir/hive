import { createDialog, confirmDiscard } from './dialog.js';
import { snapshotForm, reconcileDrawerRecord } from './drawer-sync.js';

export function createCrudDrawer(config) {
  const {
    host,
    singularLabel,
    fieldsHtml,
    populateForm,
    buildPayload,
    onSave,
    onDelete,
    onClose,
    initialFocus = '[name="name"]',
    autocomplete = 'on',
  } = config;
  if (!host || !singularLabel || !fieldsHtml || !populateForm || !buildPayload || !onSave)
    throw new Error('CRUD drawer configuration is incomplete.');
  host.innerHTML = `<app-dialog class="modal-backdrop is-hidden" role="dialog" aria-modal="true" aria-labelledby="crud-drawer-title"><div class="modal-panel modal-panel--drawer" tabindex="-1"><div class="modal-header"><h2 class="modal-title" id="crud-drawer-title">Add ${singularLabel}</h2><button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><form class="modal-body crud-drawer-form" autocomplete="${autocomplete === 'off' ? 'off' : 'on'}">${fieldsHtml}<div class="crud-drawer-notice" role="status" hidden></div><div class="crud-drawer-error" hidden></div></form><div class="modal-footer"><button type="button" class="crud-drawer-btn danger is-hidden" data-delete>Delete</button><button type="button" class="crud-drawer-btn" data-dialog-close>Cancel</button><button type="button" class="crud-drawer-btn primary" data-save>Save</button></div></div></app-dialog>`;
  const element = host.querySelector('app-dialog'),
    form = host.querySelector('form'),
    title = host.querySelector('.modal-title'),
    error = host.querySelector('.crud-drawer-error'),
    notice = host.querySelector('.crud-drawer-notice'),
    save = host.querySelector('[data-save]'),
    remove = host.querySelector('[data-delete]'),
    dialog = createDialog(element, { initialFocus });
  let record = null;
  let isOpen = false;
  let saving = false;
  let baseline = '';
  const showNotice = (message) => {
    notice.textContent = message || '';
    notice.hidden = !message;
  };
  if (autocomplete === 'off') {
    form.dataset.formType = 'other';
    form.querySelectorAll('input, textarea').forEach((field) => {
      field.setAttribute('autocomplete', 'new-password');
      field.setAttribute('data-1p-ignore', 'true');
      field.setAttribute('data-lpignore', 'true');
    });
  }
  const submit = async () => {
    if (!form.reportValidity()) return;
    save.disabled = true;
    saving = true;
    error.hidden = true;
    dialog.setBusy(true);
    try {
      await onSave(buildPayload(form, record), record);
      dialog.setBusy(false);
      dialog.close('saved');
    } catch (reason) {
      error.textContent = reason.message || 'Failed to save.';
      error.hidden = false;
      dialog.setBusy(false);
    } finally {
      saving = false;
      save.disabled = false;
    }
  };
  const deleteCurrent = async () => {
    if (!record || !onDelete) return;
    remove.disabled = true;
    error.hidden = true;
    dialog.setBusy(true);
    try {
      if ((await onDelete(record)) !== false) {
        dialog.setBusy(false);
        dialog.close('deleted');
      }
    } catch (reason) {
      error.textContent = reason.message || 'Failed to delete.';
      error.hidden = false;
    } finally {
      dialog.setBusy(false);
      remove.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  remove.addEventListener('click', deleteCurrent);
  return {
    open(next = null) {
      record = next;
      title.textContent = `${record ? 'Edit' : 'Add'} ${singularLabel}`;
      remove.classList.toggle('is-hidden', !record || !onDelete);
      showNotice('');
      populateForm(record, form);
      baseline = snapshotForm(form);
      isOpen = dialog.open({
        beforeClose: async () => {
          if (snapshotForm(form) !== baseline) {
            return await confirmDiscard();
          }
          return true;
        },
        onClose: (reason) => {
          isOpen = false;
          onClose?.(reason, record);
        },
      }) !== false;
    },
    isOpen: () => isOpen,
    current: () => record,
    // Called when the record is reloaded in the background; never closes the drawer.
    refresh(next) {
      if (!isOpen || saving) return;
      const dirty = snapshotForm(form) !== baseline;
      const action = reconcileDrawerRecord({ current: record, next, dirty });
      if (action === 'repopulate') {
        record = next;
        populateForm(record, form);
        baseline = snapshotForm(form);
        showNotice('Updated with changes made elsewhere.');
      } else if (action === 'conflict') {
        record = next;
        showNotice('This item was changed elsewhere. Your unsaved edits are kept; saving will overwrite those changes.');
      } else if (action === 'deleted') {
        save.disabled = true;
        remove.disabled = true;
        showNotice('This item was deleted elsewhere and can no longer be saved.');
      }
    },
    close: (reason) => dialog.close(reason),
    destroy() {
      dialog.destroy();
      host.replaceChildren();
    },
  };
}

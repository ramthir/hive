import { escapeHtml as esc } from '/static/html.js';
import '/static/components/combobox.js';
import { createDialog, confirmDiscard } from '/static/components/dialog.js';
import { api } from '/static/notes/api.js';
import { tagOptions } from '/static/notes/tags.js';
import { COLUMNS, PRIORITIES, drawerChanges, noteHref, taskPriority } from '/static/tasks/card.js';

const options = (items) => items.map(({ value, label }) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');

/**
 * Pandora's task drawer: a side panel with the task's properties (title, status, priority, tags). `onSave(task, changes)` does the PUT.
 */
export function createTaskDrawer({ host, onSave }) {
  host.innerHTML = `<app-dialog class="modal-backdrop is-hidden" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title">
    <div class="modal-panel modal-panel--drawer" tabindex="-1">
      <div class="modal-header"><h2 class="modal-title" id="task-drawer-title">Edit Task</h2><button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <form class="modal-body crud-drawer-form" autocomplete="off"></form>
      <div class="modal-footer"><a class="crud-drawer-btn drawer-open-note" data-open-note>Open note</a><button type="button" class="crud-drawer-btn" data-dialog-close>Cancel</button><button type="button" class="crud-drawer-btn primary" data-save>Save</button></div>
    </div></app-dialog>`;
  const element = host.querySelector('app-dialog');
  const form = host.querySelector('form');
  const error = document.createElement('div');
  const save = host.querySelector('[data-save]');
  const link = host.querySelector('[data-open-note]');
  const dialog = createDialog(element, { initialFocus: '[name="title"]' });
  let task = null;
  let vaultTags = {};

  const field = (icon, label, control, { wide = false } = {}) =>
    `<label class="field${wide ? ' field--wide' : ''}"><span class="property-label"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${label}</span>${control}</label>`;
  // A multiple combobox writes one hidden input per chip: join them into the comma-separated text the task code reads.
  const values = () => {
    const data = new FormData(form);
    return { ...Object.fromEntries(data), tags: data.getAll('tags').join(', ') };
  };
  const snapshot = () => JSON.stringify(values());

  let baseline = '';
  const submit = async () => {
    if (!form.reportValidity()) return;
    const changes = drawerChanges(task, values());
    if (!Object.keys(changes).length) return dialog.close('unchanged');
    save.disabled = true;
    error.hidden = true;
    dialog.setBusy(true);
    try {
      await onSave(task, changes);
      dialog.setBusy(false);
      dialog.close('saved');
    } catch (reason) {
      error.textContent = reason.message || 'Failed to save.';
      error.hidden = false;
      dialog.setBusy(false);
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  return {
    async open(next) {
      task = next;
      link.href = noteHref(task);
      const priority = taskPriority(task);
      form.innerHTML = `<div class="properties-form-grid">
        ${field('heading', 'Title', `<input name="title" required maxlength="255" value="${esc(task.title)}">`, { wide: true })}
        ${field('list-check', 'Status', `<app-combobox name="status" required value="${esc(task.status)}" placeholder="Select status">${options(COLUMNS)}</app-combobox>`)}
        ${field('flag', 'Priority', `<app-combobox name="priority" value="${esc(priority?.value ?? '')}" placeholder="None">${options(PRIORITIES.map(({ value, label }) => ({ value, label })))}</app-combobox>`)}
        ${field('tag', 'Tags', `<app-combobox name="tags" multiple creatable value="${esc((task.tags || []).join(','))}" placeholder="Add tags" aria-label="Tags"></app-combobox>`, { wide: true })}
      </div>`;
      error.className = 'crud-drawer-error';
      error.hidden = true;
      form.append(error);
      const tagBox = form.querySelector('app-combobox[name="tags"]');
      tagBox.optionsList = tagOptions(vaultTags, task.tags);
      api('/tags').then((counts) => {
        vaultTags = counts;
        if (!tagBox.isConnected) return;
        tagBox.optionsList = tagOptions(vaultTags, task.tags);
        if (tagBox.opened) tagBox.drawOptions();
      }).catch(() => {});
      await Promise.resolve(); // the comboboxes draw their hidden inputs a microtask after they connect
      baseline = snapshot();
      dialog.open({ beforeClose: async () => snapshot() === baseline || (await confirmDiscard()) });
    },
    isOpen: () => dialog.isOpen(),
  };
}

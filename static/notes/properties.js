import { escapeHtml as esc } from '/static/html.js';
import { confirmDiscard } from '/static/components/dialog.js';
import { isVisible, missingRequired, propertyChanges, renderFields } from '/static/notes/property-fields.js';
import '/static/components/combobox.js';
import { api } from '/static/notes/api.js';
import { tagOptions } from '/static/notes/tags.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';

/**
 * Properties: a side drawer (titled for the type, "Task Properties") with the fields of the note's type (task: project, specification, status, priority,
 * assignee, week; contact: role, project, team, billing...). Saving is one PUT with only the changed fields, so it is one
 * git commit. `onSaved(note)` gets the note as the server now has it.
 */
export async function openProperties(note, { onSaved }) {
  const { dialog, close } = openDialog(`
    ${dialogHeader('Properties')}
    <form class="modal-body crud-drawer-form" autocomplete="off">
      <p data-loading role="status">Loading properties…</p>
      <div class="properties-form-grid" hidden></div>
      <div class="crud-drawer-error" hidden></div>
    </form>
    <div class="modal-footer">
      <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
      <button type="button" class="crud-drawer-btn primary" data-action="save" disabled>Save Properties</button>
    </div>`, {
    className: 'notes-properties-drawer',
    wide: true,
    initialFocus: '.modal-panel',
    // Closing with edits in the fields asks first (Esc, the X, Cancel and the backdrop all land here).
    beforeClose: () => !(form && propertyChanges(form.fields, values())) || confirmDiscard({ message: 'Close without saving your changes to the properties?' }),
  });
  const grid = dialog.querySelector('.properties-form-grid');
  const loading = dialog.querySelector('[data-loading]');
  const error = dialog.querySelector('.crud-drawer-error');
  const save = dialog.querySelector('[data-action="save"]');
  const fail = (message) => { error.textContent = message; error.hidden = false; };
  let form;
  const values = () => Object.fromEntries([...grid.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, el.value]));
  const sync = () => {
    const now = values();
    for (const field of form.fields) grid.querySelector(`[data-field="${field.key}"]`).hidden = !isVisible(field, now);
  };

  try {
    form = await api(`/notes/${encodeURIComponent(note.slug)}/properties`);
  } catch (reason) {
    loading.hidden = true;
    return fail(reason.message || 'Could not load note properties. Close and reopen to retry.');
  }
  loading.hidden = true;
  dialog.querySelector('.modal-title').textContent = form.title; // named for the type: "Task Properties"
  grid.innerHTML = renderFields(form);
  grid.hidden = false;
  save.disabled = false;
  sync();
  grid.addEventListener('change', sync);
  const tagBox = grid.querySelector('app-combobox[multiple][data-key="tags"]');
  if (tagBox) {
    const draw = (counts) => { tagBox.optionsList = tagOptions(counts, tagBox.values); };
    draw({});
    api('/tags').then((counts) => { if (tagBox.isConnected) { draw(counts); if (tagBox.opened) tagBox.drawOptions(); } }).catch(() => {});
  }

  const submit = async () => {
    error.hidden = true;
    const body = propertyChanges(form.fields, values());
    if (!body) return close();
    const missing = missingRequired(form.fields, values());
    if (missing) {
      fail(`${missing.label} is required.`);
      grid.querySelector(`[data-key="${missing.key}"]`)?.focus?.();
      return;
    }
    save.disabled = true;
    try {
      const saved = await api(`/notes/${encodeURIComponent(note.slug)}`, { method: 'PUT', body });
      close();
      onSaved(saved);
    } catch (reason) {
      fail(reason.message || 'Could not save properties.');
      save.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  dialog.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
  });
  dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  dialog.querySelector('[data-key]')?.focus?.();
}

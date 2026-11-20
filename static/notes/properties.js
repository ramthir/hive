import { escapeHtml as esc } from '/static/html.js';
import { isVisible, propertyChanges, renderFields } from '/static/notes/property-fields.js';
import '/static/components/combobox.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';

/**
 * Note Properties: a side drawer with the fields of the note's type (task: project, specification, status, priority,
 * assignee, week; contact: role, project, team, billing...). Saving is one PUT with only the changed fields, so it is one
 * git commit. `onSaved(note)` gets the note as the server now has it.
 */
export async function openProperties(note, { onSaved }) {
  const { dialog, close } = openDialog(`
    ${dialogHeader('Note Properties')}
    <form class="modal-body crud-drawer-form" autocomplete="off">
      <p data-loading role="status">Loading properties…</p>
      <div class="properties-form-grid" hidden></div>
      <div class="crud-drawer-error" hidden></div>
    </form>
    <div class="modal-footer">
      <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
      <button type="button" class="crud-drawer-btn primary" data-action="save" disabled>Save Properties</button>
    </div>`, { className: 'notes-properties-drawer', wide: true, initialFocus: '.modal-panel' });
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
  grid.innerHTML = renderFields(form);
  grid.hidden = false;
  save.disabled = false;
  sync();
  grid.addEventListener('change', sync);

  const submit = async () => {
    error.hidden = true;
    const body = propertyChanges(form.fields, values());
    if (!body) return close();
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

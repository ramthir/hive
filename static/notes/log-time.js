import { escapeHtml as esc } from '/static/html.js';
import '/static/components/combobox.js';
import '/static/components/date-picker.js';
import '/static/components/duration-picker.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';
import { dayHint, loggedLabel, savePlan, today } from '/static/time-entries/entries.js';

/** Redraw the footer's "3h 30m logged" chip from the note's `time` map. */
export function updateLogged(root, note) {
  const chip = root.querySelector('.stat-logged');
  if (!chip) return;
  const label = loggedLabel(note?.time);
  chip.hidden = !label;
  chip.querySelector('span').textContent = label;
}

/**
 * The Log time dialog of a task or meeting note: a day and a duration, added to that day's total in one commit.
 * `onLogged(note)` gets the note as the server now has it (its `time` and `updated` changed; the editor's text did not).
 */
export function openLogTime(note, { onLogged }) {
  const { dialog, close } = openDialog(`
    ${dialogHeader('Log time')}
    <form class="modal-body crud-drawer-form" autocomplete="off">
      <p class="log-time-title">${esc(note.title)}</p>
      <div class="time-form-row">
        <label class="field">Date<app-datepicker name="day" required value="${esc(today())}"></app-datepicker></label>
        <label class="field">Duration<app-durationpicker name="minutes" required value="60"></app-durationpicker></label>
      </div>
      <p class="log-time-hint" aria-live="polite"></p>
      <div class="crud-drawer-error" hidden></div>
    </form>
    <div class="modal-footer">
      <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
      <button type="button" class="crud-drawer-btn primary" data-action="log"><i class="fa-solid fa-clock" aria-hidden="true"></i> Log time</button>
    </div>`, { initialFocus: '[data-action="log"]' });
  const form = dialog.querySelector('form');
  const hint = dialog.querySelector('.log-time-hint');
  const error = dialog.querySelector('.crud-drawer-error');
  const button = dialog.querySelector('[data-action="log"]');
  const values = () => Object.fromEntries(new FormData(form));
  const showHint = () => { hint.textContent = values().day ? dayHint(note.time, values().day) : ''; };
  form.querySelector('app-datepicker').addEventListener('change', showHint);
  showHint();

  button.addEventListener('click', async () => {
    error.hidden = true;
    button.disabled = true;
    try {
      const [call] = savePlan(null, { ...values(), slug: note.slug });
      await api(call.path, { method: call.method, body: call.body });
      const fresh = await api(`/notes/${encodeURIComponent(note.slug)}`);
      close();
      onLogged(fresh, Number(call.body.minutes));
    } catch (reason) {
      error.textContent = reason.message || 'Could not log time.';
      error.hidden = false;
      button.disabled = false;
    }
  });
}

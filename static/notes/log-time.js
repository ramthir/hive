import { escapeHtml as esc } from '/static/html.js';
import '/static/components/combobox.js';
import '/static/components/date-picker.js';
import '/static/components/duration-picker.js';
import { showToast } from '/static/toast.js';
import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';
import { formatDay, formatDuration, today } from '/static/time-entries/format.js';
import { dayHint, loggedLabel } from '/static/time-entries/logged.js';
import { savePlan } from '/static/time-entries/entries.js';

/** Redraw the footer's "3h 30m logged" chip from the note's `time` map. */
export function updateLogged(root, note) {
  const chip = root.querySelector('.stat-logged');
  if (!chip) return;
  const label = loggedLabel(note?.time);
  chip.hidden = !label;
  chip.querySelector('span').textContent = label;
}

/**
 * The Log time dialog of a task or meeting note: a day and a duration, added to that day's total in one commit, and the
 * days already logged, each removable (one commit). `onLogged(note, minutes)` / `onRemoved(note, day)` get the note as the
 * server now has it (its `time`, `updated` and `revision` changed; the editor's text did not).
 */
export function openLogTime(note, { onLogged, onRemoved }) {
  let time = { ...note.time };
  const { dialog, close } = openDialog(`
    ${dialogHeader('Log time')}
    <form class="modal-body crud-drawer-form" autocomplete="off">
      <p class="log-time-title">${esc(note.title)}</p>
      <div class="form-row">
        <label class="field">Date<app-datepicker name="day" required value="${esc(today())}"></app-datepicker></label>
        <label class="field">Duration<app-durationpicker name="minutes" required value="60"></app-durationpicker></label>
      </div>
      <p class="log-time-hint" aria-live="polite"></p>
      <ul class="log-time-days" aria-label="Logged on this note"></ul>
      <div class="crud-drawer-error" hidden></div>
    </form>
    <div class="modal-footer">
      <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
      <button type="button" class="crud-drawer-btn primary" data-action="log"><i class="fa-solid fa-clock" aria-hidden="true"></i> Log time</button>
    </div>`, { initialFocus: 'app-durationpicker .combobox-input' });
  const form = dialog.querySelector('form');
  const hint = dialog.querySelector('.log-time-hint');
  const error = dialog.querySelector('.crud-drawer-error');
  const button = dialog.querySelector('[data-action="log"]');
  const values = () => Object.fromEntries(new FormData(form));
  const days = dialog.querySelector('.log-time-days');
  const showHint = () => { hint.textContent = values().day ? dayHint(time, values().day) : ''; };
  const showDays = () => {
    days.innerHTML = Object.keys(time).sort().reverse().map((day) => `<li><span>${esc(formatDay(day))}</span><span>${esc(formatDuration(time[day]))}</span>
      <button type="button" class="tool-button danger" data-remove="${esc(day)}" aria-label="Remove ${esc(formatDay(day))}" title="Remove this day"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></li>`).join('');
    days.hidden = !days.children.length;
    showHint();
  };
  form.querySelector('app-datepicker').addEventListener('change', showHint);
  showDays();
  days.addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-remove]');
    if (!remove) return;
    const day = remove.dataset.remove;
    error.hidden = true;
    remove.disabled = true;
    try {
      await api(`/notes/${encodeURIComponent(note.slug)}/time/${encodeURIComponent(day)}`, { method: 'DELETE' });
      const fresh = await api(`/notes/${encodeURIComponent(note.slug)}`);
      time = { ...fresh.time };
      showDays();
      onRemoved?.(fresh, day);
    } catch (reason) {
      error.textContent = reason.message || 'Could not remove the time.';
      error.hidden = false;
      remove.disabled = false;
    }
  });

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
  form.addEventListener('submit', (event) => { event.preventDefault(); button.click(); });
  dialog.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); button.click(); }
  });
}

// Logging time commits only the note's `time` key; the page keeps its text and redraws only the footer chip.
export function logReadPageTime(app) {
  const note = app.note;
  if (!note) return;
  const applied = (fresh) => {
    if (app.note?.slug !== note.slug) return false;
    app.note = { ...app.note, time: fresh.time, updated: fresh.updated, revision: fresh.revision };
    updateUpdatedStamp(app, app.note);
    updateLogged(app, app.note);
    return true;
  };
  openLogTime(note, {
    onLogged: (fresh, minutes) => { if (applied(fresh)) showToast(`Logged ${formatDuration(minutes)} · ${note.title}`, 'success'); },
    onRemoved: (fresh, day) => { if (applied(fresh)) showToast(`Removed ${formatDay(day)} · ${note.title}`, 'success'); },
  });
}

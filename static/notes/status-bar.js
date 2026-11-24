import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/relative-time.js';
import { chatButtonHtml } from '/static/notes/note-chat.js';
import { canLogTime, loggedLabel } from '/static/time-entries/logged.js';

/* The note footer bar: word count, reading time, last-updated stamp, save button state, and the shared read-page action bar. */

const READING_WORDS_PER_MINUTE = 75;

export function noteStats(text) {
  const content = String(text || '');
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return {
    words,
    chars: content.length,
    readingMinutes: words ? Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE)) : 0,
  };
}

export function updateStats(root, text) {
  const { words, chars, readingMinutes } = noteStats(text);
  const wordsEl = root.querySelector('.stat-words .stat-value');
  const readingEl = root.querySelector('.stat-reading .stat-value');
  if (wordsEl) wordsEl.textContent = words.toLocaleString();
  if (readingEl) readingEl.textContent = readingMinutes;
  const stats = root.querySelector('.notes-footer-stats');
  if (stats) stats.title = `${chars.toLocaleString()} characters`;
}

/** `status` is 'dirty', 'saving' or anything else (clean). */
export function updateSaveIndicator(root, status) {
  const button = root.querySelector('#save-note-btn');
  if (!button) return;
  button.className = `tool-button save ${status === 'dirty' ? 'dirty' : 'clean'}`;
  if (status === 'saving') {
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    button.title = 'Saving note';
  } else {
    button.disabled = status !== 'dirty';
    button.title = 'Save note';
    button.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>';
  }
}

export function updateUpdatedStamp(root, note) {
  const stamp = root.querySelector('.stat-updated span');
  if (stamp && note?.updated) stamp.textContent = `Updated ${formatRelativeTime(note.updated)}`;
}

/** Shared `<app-action-bar>` for read pages (/tables, /timelines, /specifications, /tasks). */
export function renderReadActionBar(note, { typeLabel, typeIconName, actions, statsHtml = '' }) {
  const loggable = Boolean(actions?.logTime) && canLogTime(note);
  const logged = loggable ? loggedLabel(note.time) : '';
  return `
    <app-action-bar fixed class="notes-action-bar" aria-label="${esc(typeLabel)} status and actions">
      <div class="action-bar-left notes-footer-left">
        <span class="notes-type-label"><i class="fa-solid fa-${esc(typeIconName)}" aria-hidden="true"></i><span>${esc(typeLabel)}</span></span>
        ${statsHtml ? `<span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span><div class="notes-footer-stats">${statsHtml}</div>` : ''}
        <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
        <div class="action-bar-status notes-footer-status">
          <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
            <i class="fa-regular fa-clock" aria-hidden="true"></i>
            <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
          </span>
          ${loggable ? `<span class="stat-logged" title="Time logged on this note"${logged ? '' : ' hidden'}><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> <span>${esc(logged)}</span></span>` : ''}
        </div>
      </div>
      <div class="action-bar-right notes-footer-actions">
        <div class="map-toolbar" aria-label="${esc(typeLabel)} actions">
          <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
          <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
          ${loggable ? '<button id="log-time-btn" class="tool-button" type="button" title="Log time" aria-label="Log time"><i class="fa-solid fa-clock" aria-hidden="true"></i></button>' : ''}
          ${note.has_properties ? '<button id="note-properties-btn" class="tool-button" type="button" title="Edit note properties" aria-label="Edit note properties"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>' : ''}
          ${chatButtonHtml(actions?.chatOpen?.())}
          <button id="note-versions-btn" class="tool-button" type="button" title="History" aria-label="History"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>
          <button id="edit-note-btn" class="tool-button notes-edit-toggle" type="button" title="Edit markdown" aria-label="Edit note" aria-pressed="false"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>
        </div>
      </div>
    </app-action-bar>`;
}

export function wireReadActionBar(host, actions) {
  for (const [id, run] of Object.entries({
    'delete-note-btn': 'delete', 'copy-note-btn': 'copy', 'log-time-btn': 'logTime',
    'note-properties-btn': 'properties', 'note-versions-btn': 'versions',
    'edit-note-btn': 'edit', 'note-chat-btn': 'chat',
  })) host.querySelector(`#${id}`)?.addEventListener('click', () => actions[run]?.());
}

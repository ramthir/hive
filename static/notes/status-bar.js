import { formatRelativeTime } from '/static/time-format.js';

/* The editor's footer: word count, reading time, last-updated stamp, and the save button's state. */

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

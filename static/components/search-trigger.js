/*
 * The header's search field. One definition for every page header: it looks like a search input
 * (icon, placeholder, key hint) but is a button that opens the note spotlight. Sizing and colours
 * come from the --search-* tokens in tokens.css, styled by .header-search in hive.css.
 */
const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
export const SEARCH_SHORTCUT_KEY = isMac ? '⌘K' : 'Ctrl+K';

export function renderSearchTrigger() {
  return `<button id="search-notes-btn" class="header-search" type="button" title="Search notes (${SEARCH_SHORTCUT_KEY})" aria-label="Search notes">
    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span class="header-search-label">Search notes…</span><kbd class="header-search-key">${SEARCH_SHORTCUT_KEY}</kbd>
  </button>`;
}

export function wireSearchTrigger(root) {
  root.querySelector('#search-notes-btn')?.addEventListener('click', () => document.querySelector('note-spotlight')?.open());
}

/** The same field as a real input, for pages that filter what they show (the rows of a table note): same look, you type in it. */
export function renderFilterField({ placeholder = 'Filter…', value = '', label = placeholder, inputClass = '', shortcut = '' } = {}) {
  const esc = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<label class="header-search header-search--filter">
    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input class="header-search-input ${esc(inputClass)}" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" autocomplete="off" value="${esc(value)}" />${shortcut ? `<kbd class="header-search-key">${esc(shortcut)}</kbd>` : ''}
  </label>`;
}

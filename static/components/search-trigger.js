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

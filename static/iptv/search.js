/** Suggestions for the Library search box (no DOM, unit-tested in tests/js/iptv.test.mjs): typing `group:` offers the provider's categories, `is:` the starred filter. */

/** The word at the caret: where it starts and ends in the text, and what is before the caret. */
export function searchToken(value, cursor = value.length) {
  const start = value.slice(0, cursor).search(/\S*$/);
  const tail = value.slice(cursor).search(/\s/);
  return { start, end: tail < 0 ? value.length : cursor + tail, prefix: value.slice(start, cursor) };
}

const MAX = 12;

/** Offer matching categories for the current word or an explicit group: filter. */
export function groupSuggestions(groups, value, cursor = value.length) {
  const { prefix } = searchToken(value, cursor);
  const lower = prefix.toLowerCase();
  if (!lower || (lower.includes(':') && !lower.startsWith('group:'))) return [];
  const fragment = lower.startsWith('group:')
    ? lower.slice(6).replace(/^"/, '')
    : 'group:'.startsWith(lower) ? '' : lower;
  const matches = (groups || [])
    .map((group) => ({ group, name: group.name.trim().toLowerCase() }))
    .filter(({ name }) => name.includes(fragment));
  const rank = (name) => {
    if (name === fragment) return 0;
    return name.startsWith(fragment) ? 1 : 2;
  };
  return matches
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, MAX)
    .map(({ group }) => {
      const term = groupTerm(group.name);
      return { value: term, label: term, badge: String(group.count) };
    });
}

/** `group:tamil`, or `group:"Tamil Movies"` when the name has spaces. */
export function groupTerm(name) {
  const clean = String(name).replace(/"/g, '').trim();
  return /\s/.test(clean) ? `group:"${clean}"` : `group:${clean}`;
}

/** Put the chosen term in place of the word at the caret, followed by a space; returns the new text and where the caret goes. */
export function insertTerm(value, cursor, term) {
  const { start, end } = searchToken(value, cursor);
  return { value: value.slice(0, start) + term + ' ' + value.slice(end).trimStart(), cursor: start + term.length + 1 };
}

export const STARRED_TERM = 'is:starred';

/** A word that starts like `is:starred` (i, is, is:, is:st) offers the starred filter, unless the search already has it. */
export function starredSuggestions(value, cursor = value.length) {
  const { prefix } = searchToken(value, cursor);
  const lower = prefix.toLowerCase();
  if (!lower || lower === STARRED_TERM || !STARRED_TERM.startsWith(lower) || /(^|\s)is:starred(\s|$)/i.test(value.slice(0, cursor - prefix.length) + ' ' + value.slice(cursor))) return [];
  return [{ value: STARRED_TERM, label: STARRED_TERM, badge: '\u2605' }];
}

/** Does the search ask for the starred only? (The page then drops an item from view when it is unstarred.) */
export function wantsStarred(q) {
  return /(^|\s)is:star(red)?(\s|$)/i.test(q || '');
}

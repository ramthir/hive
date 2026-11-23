/** Suggestions for the Library search box (no DOM, unit-tested in tests/js/iptv.test.mjs): typing `group:` offers the provider's categories. */

/** The word at the caret: where it starts and ends in the text, and what is before the caret. */
export function searchToken(value, cursor = value.length) {
  const start = value.slice(0, cursor).search(/\S*$/);
  const tail = value.slice(cursor).search(/\s/);
  return { start, end: tail < 0 ? value.length : cursor + tail, prefix: value.slice(start, cursor) };
}

const MAX = 12;

/** `groups` is [{name, count}]. A word that starts like `group:` (g, gr, group:, group:tam) offers the categories that contain what follows. */
export function groupSuggestions(groups, value, cursor = value.length) {
  const { prefix } = searchToken(value, cursor);
  const lower = prefix.toLowerCase();
  if (!lower || !('group:'.startsWith(lower) || lower.startsWith('group:'))) return [];
  const fragment = lower.startsWith('group:') ? lower.slice(6).replace(/^"/, '') : '';
  const matches = (groups || []).filter((g) => g.name.toLowerCase().includes(fragment));
  const rank = (g) => (g.name.toLowerCase().startsWith(fragment) ? 0 : 1);
  return matches
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .slice(0, MAX)
    .map(({ g }) => ({ value: groupTerm(g.name), label: g.name, badge: String(g.count) }));
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

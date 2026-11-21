// Tag suggestions for the footer's tag field, and the chips shown in read mode. DOM-free, so it is unit tested.
import { escapeHtml as esc } from '../html.js';

/** The note's tags as buttons for read mode; each one searches the notes for that tag. */
export const tagChips = (tags = []) => (tags || []).map((tag) =>
  `<button type="button" class="notes-tag-chip" data-tag="${esc(tag)}" title="Search notes for ${esc(tag)}">${esc(tag)}</button>`).join('');

/** The tags in use (`GET /api/tags`, name -> notes) and the note's own, by name ignoring case, each with its count. */
export function tagOptions(counts = {}, current = []) {
  const names = new Set([...Object.keys(counts || {}), ...(current || [])].map((t) => String(t).trim()).filter(Boolean));
  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
    .map((name) => ({ value: name, label: name, ...(counts?.[name] ? { meta: String(counts[name]) } : {}) }));
}

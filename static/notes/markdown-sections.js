/* Shared, DOM-free helpers for scanning markdown headings, code fences, checklists and wiki link labels. */

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const H2 = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?\s*$/;
const CHECK_BOX = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;
const CHECK_OR_LIST = /^ ?(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\](?=\s|$))?/;
const SCOPE_MARK = /^\s*(?:\*\*|__)?\s*(in|out of)[ -]scope\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;

/** Lines outside code fences are the only ones that can start a heading or a bullet. */
export function* lines(content) {
  let fence = '';
  for (const text of String(content || '').split(/\r?\n/)) {
    const marker = FENCE.exec(text);
    const opens = marker && (marker[1][0] === '~' || !marker[2].includes('`'));
    yield { text, plain: !fence && !opens };
    if (!fence && opens) fence = marker[1];
    else if (fence && marker?.[1].startsWith(fence) && !marker[2].trim()) fence = '';
  }
}

export const trimBlank = (list) => {
  let start = 0;
  let end = list.length;
  while (start < end && !list[start].trim()) start += 1;
  while (end > start && !list[end - 1].trim()) end -= 1;
  return list.slice(start, end);
};

export const sectionKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Strip emoji and keycap sequences from a heading name; a name made only of emoji is kept as written. */
export const withoutEmoji = (name) =>
  String(name || '').replace(/[0-9#*]\ufe0f?\u20e3/g, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim() || String(name || '');

/** Split markdown into `{ lead, sections: [{ name, key, body }] }` at `##` headings outside code fences. */
export function splitSections(content, { stripEmoji = false, singleH1 = false } = {}) {
  const sections = [];
  const before = [];
  let current = null;
  let skippedTitle = false;
  for (const { text, plain } of lines(content)) {
    const heading = plain ? H2.exec(text) : null;
    const rawName = heading ? heading[1].trim() : '';
    const name = rawName && stripEmoji ? withoutEmoji(rawName) : rawName;
    if (name) {
      current = { name, key: sectionKey(name), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(text);
    } else if (singleH1 && plain && !skippedTitle && /^#\s+\S/.test(text)) {
      skippedTitle = true;
    } else if (!singleH1 && /^#\s/.test(text)) {
      // skip `# Title` lines before the first section
    } else {
      before.push(text);
    }
  }
  return {
    lead: trimBlank(before).join('\n'),
    sections: sections.map((section) => ({ ...section, body: trimBlank(section.body).join('\n') })),
  };
}

/** `{ done, total }` of checklist items outside code fences. */
export function countChecklist(content, { requireBox = true } = {}) {
  const pattern = requireBox ? CHECK_BOX : CHECK_OR_LIST;
  let done = 0;
  let total = 0;
  for (const { text, plain } of lines(content)) {
    const item = plain ? pattern.exec(text) : null;
    if (!item) continue;
    total += 1;
    if (item[1] && item[1] !== ' ') done += 1;
  }
  return { done, total };
}

/** `[[Target|Alias]]` or `[[Target]]` -> `Target`; plain text is trimmed as-is. */
export function unwrapWikilink(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return (/^\[\[([^|\]#]+)(?:[|#][^\]]*)?\]\]$/.exec(text)?.[1] ?? text).trim();
}

/** A Scope section's text split at its "In scope:" / "Out of scope:" lines: `[{kind: 'in' | 'out' | '', body}]` in file order
    (text before the first such line has kind ''). A section with no such line comes back as one group of kind ''. */
export function scopeGroups(body) {
  const groups = [{ kind: '', lines: [] }];
  for (const { text, plain } of lines(body)) {
    const mark = plain ? SCOPE_MARK.exec(text) : null;
    if (mark) groups.push({ kind: mark[1].toLowerCase() === 'in' ? 'in' : 'out', lines: [] });
    else groups[groups.length - 1].lines.push(text);
  }
  return groups
    .map((group) => ({ kind: group.kind, body: trimBlank(group.lines).join('\n') }))
    .filter((group, index) => group.body || (group.kind && index > 0));
}

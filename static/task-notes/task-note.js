import { lines, trimBlank } from '/static/specifications/specification-note.js';

/* A task note (`type: task`) is read as a short lead, then one card per `##` section, with an outline and a progress count
   for the `- [ ]` / `- [x]` items. The vault's tasks are free-form (Why, What Changes, Acceptance Criteria, Plan, Verification,
   or just a checklist), so nothing here expects a structure: sections are shown in file order and the markdown stays the
   only source (nothing is written back). DOM-free. */

const H2 = /^##\s+(.+?)\s*#*\s*$/;
const CHECK = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;

export const isTaskNote = (note) => (note?.types || []).some((type) => String(type).toLowerCase() === 'task');

/** The heading's name without leading emoji or symbols, lower case: "✅ Deliverables" -> "deliverables". */
export const plainName = (name) => String(name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase().replace(/\s+/g, ' ');

const KINDS = {
  'open questions': 'questions',
  'out of scope': 'out',
  scope: 'scope',
  'in scope': 'scope',
  'acceptance criteria': 'criteria',
  'success criteria': 'criteria',
  deliverables: 'criteria',
  verification: 'verified',
  'summary of completed work': 'verified',
  related: 'refs',
  'related notes': 'refs',
  references: 'refs',
};

/** How a section is drawn: `scope`, `criteria`, `questions`, `out`, `verified`, `refs` or '' (plain). */
export const sectionKind = (name) => KINDS[plainName(name)] || '';

/** `{done, total}` of the checklist items in a text, ignoring code fences. */
export function checklist(content) {
  let done = 0;
  let total = 0;
  for (const { text, plain } of lines(content)) {
    const item = plain ? CHECK.exec(text) : null;
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') done += 1;
  }
  return { done, total };
}

/** `{lead, sections: [{name, kind, body, done, total}], progress}` from the note's text (the `# Title` line excluded). */
export function parseTask(content) {
  const sections = [];
  const before = [];
  let current = null;
  for (const { text, plain } of lines(content)) {
    const heading = plain ? H2.exec(text) : null;
    if (heading) {
      current = { name: heading[1].trim(), kind: sectionKind(heading[1]), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(text);
    } else if (!/^#\s/.test(text)) {
      before.push(text);
    }
  }
  const out = sections.map((section) => {
    const body = trimBlank(section.body).join('\n');
    return { ...section, body, ...checklist(body) };
  });
  return { lead: trimBlank(before).join('\n'), sections: out, progress: checklist(String(content || '')) };
}

/** Tags worth a chip: not the status words a column already says, not a priority, not the project's own name. */
export function visibleTags(tags, project = '') {
  const skip = new Set(['todo', 'done', 'must', 'important', 'nice-to-have', String(project).trim().toLowerCase()]);
  return (tags || []).filter((tag) => !skip.has(String(tag).trim().replace(/^#/, '').toLowerCase()));
}

/** `[[Acme]]` or `Acme` -> `Acme`. */
export const projectName = (value) => String(value || '').replace(/^\[\[|\]\]$/g, '').trim();

const SCOPE_MARK = /^\s*(?:\*\*|__)?\s*(in|out of)[ -]scope\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

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

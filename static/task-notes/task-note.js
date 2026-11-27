import { bulletCount, countChecklist, lines, splitSections, trimBlank, unwrapWikilink } from '../notes/markdown-sections.js';

/* A task note (`type: task`) is read as a short lead, then one card per `##` section, with an outline and a progress count
   for the `- [ ]` / `- [x]` items. The vault's tasks are free-form (Why, What Changes, Acceptance Criteria, Plan, Verification,
   or just a checklist), so nothing here expects a structure: the Markdown stays the
   only source (nothing is written back). DOM-free. */

export const isTaskNote = (note) => (note?.types || []).some((type) => String(type).toLowerCase() === 'task');

/** The heading's name without leading emoji or symbols, lower case: "✅ Deliverables" -> "deliverables". */
const plainName = (name) => String(name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase().replace(/\s+/g, ' ');

const KINDS = {
  summary: 'summary',
  why: 'why',
  background: 'background',
  findings: 'findings',
  'open questions': 'questions',
  'out of scope': 'out',
  plan: 'plan',
  scope: 'scope',
  'in scope': 'scope',
  'acceptance criteria': 'criteria',
  'success criteria': 'criteria',
  deliverables: 'criteria',
  verification: 'verified',
  'summary of completed work': 'verified',
  related: 'related',
  'related notes': 'related',
  references: 'refs',
};

/** Classify standard headings for ordering and rendering. Custom headings return an empty string. */
export const sectionKind = (name) => KINDS[plainName(name)] || '';

/** `{lead, sections: [{name, kind, body, done, total, questions, steps}], progress}` from the note's text (the `# Title` line excluded). */
export function parseTask(content) {
  const { lead, sections } = splitSections(content);
  const out = sections.map((section) => {
    const kind = sectionKind(section.name);
    return {
      ...section,
      kind,
      ...countChecklist(section.body),
      questions: kind === 'questions' ? bulletCount(section.body) : 0,
      steps: kind === 'plan' ? planSteps(section.body).steps.length : 0,
    };
  });
  return { lead, sections: out, progress: countChecklist(String(content || '')) };
}

const SECTION_ORDER = new Map([
  ['summary', -1], ['why', 0], ['background', 1], ['scope', 2], ['out', 2], ['plan', 3],
  ['criteria', 4], ['questions', 5], ['findings', 6], ['verified', 6],
  ['related', 7], ['refs', 7],
]);

/** Order standard sections for display, leaving custom sections in their original slots. */
export function taskViewSections(sections) {
  const entries = sections.map((section, index) => ({
    ...section,
    id: `task-s${index}`,
    order: SECTION_ORDER.get(section.kind),
  }));
  const standard = entries.filter(({ order }) => order !== undefined).sort((a, b) => a.order - b.order);
  let next = 0;
  return entries.map((entry) => entry.order === undefined ? entry : standard[next++]);
}

/** Tags worth a chip: not the status words a column already says, not a priority, not the project's own name. */
export function visibleTags(tags, project = '') {
  const skip = new Set(['todo', 'done', 'must', 'important', 'nice-to-have', String(project).trim().toLowerCase()]);
  return (tags || []).filter((tag) => !skip.has(String(tag).trim().replace(/^#/, '').toLowerCase()));
}

/** `[[Acme]]` or `Acme` -> `Acme`. */
export const projectName = unwrapWikilink;

const STEP = /^\d+[.)]\s+(.*)$/;
const FENCE_LINE = /^\s*(```|~~~)/;
const LEAD = /^\*\*(.+?)\*\*\s*([.:])?\s*(.*)$/s;

/** A Plan section as numbered steps: `{before, steps: [{name, body}], after}`. A step is a top-level `1.` item with its
    indented lines (and indented code fences); `name` is its leading **bold** words (without a closing full stop or colon),
    `body` the rest as markdown. `before` is the text above the list, `after` everything from the first line that is neither
    a step nor indented (a `###` block, a code fence, a table). No numbered item: no steps, the whole text is `before`. */
export function planSteps(body) {
  const before = [];
  const after = [];
  const raw = [];
  let state = 'before';
  let fence = null; // where the lines of an open code fence go
  for (const text of String(body || '').split(/\r?\n/)) {
    if (fence) {
      fence.push(fence === raw.at(-1)?.lines ? text.replace(/^ {1,4}/, '') : text);
      if (FENCE_LINE.test(text)) fence = null;
      continue;
    }
    const step = STEP.exec(text);
    const open = FENCE_LINE.test(text);
    if (step) {
      state = 'list';
      raw.push({ lines: [step[1]] });
    } else if (state === 'list' && (!text.trim() || /^\s/.test(text))) {
      raw.at(-1).lines.push(text.replace(/^ {1,4}/, ''));
      if (open) fence = raw.at(-1).lines;
    } else {
      if (state === 'list') state = 'after';
      (state === 'after' ? after : before).push(text);
      if (open) fence = state === 'after' ? after : before;
    }
  }
  if (!raw.length) return { before: String(body || '').trim(), steps: [], after: '' };
  const steps = raw.map(({ lines: stepLines }) => {
    const text = trimBlank(stepLines).join('\n');
    const lead = LEAD.exec(text);
    return lead ? { name: lead[1].replace(/[.:]$/, '').trim(), body: lead[3] } : { name: '', body: text };
  });
  return { before: trimBlank(before).join('\n'), steps, after: trimBlank(after).join('\n') };
}

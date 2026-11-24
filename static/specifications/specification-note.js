/* A specification note (`type: specification`, or `spec`) is read as an objective, a scope, requirements (each `### Name`
   with a SHALL/MUST statement and `condition -> outcome` scenarios), out of scope, open questions and references: the
   structure the vault's AGENTS.md calls "Specification Structure". The markdown stays the source of truth; nothing here
   writes it back. Older notes (Introduction, Acceptance Criteria, bullet requirements) still read: unknown `##` sections
   are shown as they are, in file order. DOM-free. */

const H2 = /^##\s+(.+?)\s*#*\s*$/;
const H3 = /^###\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*[-*+]\s+(.*\S)\s*$/;
const ARROW = /\s*(?:->|→)\s*/;
// "Given a user, when they sign in, then a session starts" (given is optional; bold or a colon after a keyword is fine).
const GWT = /^(?:given:?\s+(.+?)[,;]?\s+)?when:?\s+(.+?)[,;]?\s+then:?\s+(.+)$/is;
const STRONG = /\b(SHALL|MUST)\b/;
const PANDORA = /exported from pandora/i;

export const MAX_SCENARIOS = 3;
export const LONG_SPEC_LINES = 80; // "about 60 lines": past this a note probably covers more than one capability
export const VERIFIED_STALE_DAYS = 14;
export const STATUSES = ['Draft', 'Active', 'Deprecated'];
export const KNOWN_SECTIONS = ['objective', 'scope', 'requirements', 'out of scope', 'open questions', 'references'];

export const isSpecificationNote = (note) => (note?.types || []).some((type) => ['specification', 'spec'].includes(String(type).toLowerCase()));

export const sectionKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Lines outside code fences are the only ones that can start a heading or a bullet. */
function* lines(content) {
  let fence = false;
  for (const text of String(content || '').split(/\r?\n/)) {
    const opens = FENCE.test(text);
    yield { text, plain: !fence && !opens };
    if (opens) fence = !fence;
  }
}

const trimBlank = (list) => {
  let start = 0;
  let end = list.length;
  while (start < end && !list[start].trim()) start += 1;
  while (end > start && !list[end - 1].trim()) end -= 1;
  return list.slice(start, end);
};

/** One requirement from the lines under its `###`: the statement, the scenarios and whatever else is there (diagram, table, bullets). */
function requirement(name, body) {
  const statement = [];
  const scenarios = [];
  const rest = [];
  let fence = false;
  let started = false; // once something other than the statement paragraph appears, later paragraphs belong to `rest`
  for (const text of body) {
    const opens = FENCE.test(text);
    if (fence || opens) {
      started = true;
      rest.push(text);
      if (opens) fence = !fence;
      continue;
    }
    const bullet = BULLET.exec(text);
    const parts = bullet ? bullet[1].split(ARROW) : [];
    const gwt = bullet && parts.length < 2 ? GWT.exec(bullet[1].replace(/\*\*|__/g, '')) : null;
    if (bullet && parts.length >= 2) {
      started = true;
      scenarios.push({ when: parts[0].trim(), then: parts.slice(1).join(' -> ').trim() });
    } else if (gwt) {
      started = true;
      scenarios.push({ given: gwt[1]?.trim() || '', when: gwt[2].trim(), then: gwt[3].trim(), gwt: true });
    } else if (!started && !bullet && !/^\s*[|#>]/.test(text) && text.trim()) {
      statement.push(text.trim());
    } else if (!started && !text.trim() && statement.length) {
      started = true;
    } else if (text.trim() || rest.length) {
      started = started || Boolean(text.trim());
      rest.push(text);
    }
  }
  const statementText = statement.join(' ');
  return { name, statement: statementText, strong: STRONG.test(statementText), scenarios, rest: trimBlank(rest).join('\n') };
}

/** `{lead, sections, requirements, issues, legacy, lineCount}` from the note's text (the `# Title` line and frontmatter excluded). */
export function parseSpecification(content) {
  const sections = [];
  let current = null;
  let before = [];
  for (const { text, plain } of lines(content)) {
    const heading = plain ? H2.exec(text) : null;
    if (heading) {
      current = { name: heading[1].trim(), key: sectionKey(heading[1]), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(text);
    } else if (!/^#\s/.test(text)) {
      before.push(text);
    }
  }
  const out = sections.map((section) => ({ ...section, body: trimBlank(section.body).join('\n') }));
  const requirements = [];
  const requirementsSection = out.find((section) => section.key === 'requirements');
  if (requirementsSection) {
    let name = null;
    let body = [];
    const flush = () => { if (name !== null) requirements.push(requirement(name, body)); };
    let intro = [];
    for (const { text, plain } of lines(requirementsSection.body)) {
      const heading = plain ? H3.exec(text) : null;
      if (heading) {
        flush();
        name = heading[1].trim();
        body = [];
      } else if (name === null) {
        intro.push(text);
      } else {
        body.push(text);
      }
    }
    flush();
    requirementsSection.intro = trimBlank(intro).join('\n');
  }
  const body = String(content || '');
  const lineCount = body.split(/\r?\n/).filter((line) => line.trim()).length;
  const lead = out.find((section) => section.key === 'objective')?.body || '';
  const keys = out.map((section) => section.key);
  const legacy = keys.includes('acceptance criteria') || PANDORA.test(body) || (!keys.includes('objective') && !keys.includes('requirements'));
  return { lead, sections: out, requirements, issues: checkSpecification({ sections: out, requirements, lineCount, body, keys }), legacy, lineCount, before: trimBlank(before).join('\n') };
}

/** What differs from the vault's specification structure: short sentences, never an error. */
export function checkSpecification({ sections, requirements, lineCount, body, keys }) {
  const issues = [];
  if (!keys.includes('objective')) issues.push('No Objective section.');
  if (!keys.includes('requirements')) issues.push('No Requirements section.');
  if (keys.includes('acceptance criteria')) issues.push('Has an Acceptance Criteria section: each requirement carries its own scenarios now.');
  if (PANDORA.test(body)) issues.push('Still has an "Exported from Pandora" line.');
  const seen = new Set();
  for (const item of requirements) {
    const id = item.name.toLowerCase();
    if (seen.has(id)) issues.push(`Two requirements are named "${item.name}".`);
    seen.add(id);
    if (!item.strong) issues.push(`"${item.name}" has no SHALL or MUST statement.`);
    if (item.scenarios.length > MAX_SCENARIOS) issues.push(`"${item.name}" has ${item.scenarios.length} scenarios (at most ${MAX_SCENARIOS}).`);
  }
  if (lineCount > LONG_SPEC_LINES) issues.push(`${lineCount} lines: a long specification may cover more than one capability.`);
  return issues;
}

/** Whole days since a `verified:` date, or null when there is none or it is not a date. */
export function verifiedAge(verified, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(verified || '').trim());
  if (!match) return null;
  const then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

export const verifiedStale = (age) => age === null || age > VERIFIED_STALE_DAYS;

/** Draft, Active or Deprecated (any case) as the canonical name; anything else comes back as typed, '' when absent. */
export function statusLabel(status) {
  const text = String(status || '').trim();
  return STATUSES.find((name) => name.toLowerCase() === text.toLowerCase()) || text;
}

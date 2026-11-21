/* A timeline note (`type: timeline`) is read as a list of phases: each `## Label — Title` heading, the paragraph under
   it and its bullet list. The markdown stays the source of truth; nothing here writes it back. DOM-free. */

const HEADING_RE = /^##\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*\S)\s*$/;
const SEPARATOR_RE = /\s+[—–]\s+|\s+-\s+/;
const WIKILINK_RE = /\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g;

export const isTimelineNote = (note) => (note?.types || []).some((type) => String(type).toLowerCase() === 'timeline');

/** Plain text of a markdown line: wiki links show their label, emphasis and code marks go. */
export function plainText(text) {
  return String(text || '')
    .replace(WIKILINK_RE, (_all, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

export function splitHeading(heading) {
  const text = plainText(heading);
  const match = SEPARATOR_RE.exec(text);
  if (!match) return { label: '', title: text };
  return { label: text.slice(0, match.index).trim(), title: text.slice(match.index + match[0].length).trim() };
}

function finish(phase) {
  const summary = phase.paragraph.join(' ').replace(/\s+/g, ' ').replace(/\s*Key tasks:?\s*$/i, '').trim();
  return {
    label: phase.label, title: phase.title, summary: plainText(summary), tasks: phase.tasks.map(plainText),
  };
}

/** `{phases: [{label, title, summary, tasks}]}` from the note's text (frontmatter excluded). */
export function parseTimeline(content) {
  const phases = [];
  let current = null;
  let fence = false;
  for (const line of String(content || '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current) phases.push(finish(current));
      current = { ...splitHeading(heading[1]), paragraph: [], tasks: [] };
      continue;
    }
    if (!current) continue;
    const bullet = BULLET_RE.exec(line);
    if (bullet) current.tasks.push(bullet[1]);
    else if (line.trim() && !current.tasks.length) current.paragraph.push(line.trim());
  }
  if (current) phases.push(finish(current));
  return { phases };
}

/** A phase as markdown, for the copy button: its heading, the paragraph and the bullets. */
export function phaseMarkdown(phase) {
  const heading = `## ${[phase.label, phase.title].filter(Boolean).join(' — ')}`;
  return [heading, phase.summary, phase.tasks.map((task) => `- ${task}`).join('\n')].filter(Boolean).join('\n\n');
}

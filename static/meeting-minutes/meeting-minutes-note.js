import { normalizeType } from '/static/type-icons.js';
import { lines, sectionKey, trimBlank } from '/static/specifications/specification-note.js';

export const isMeetingMinutesNote = (note) =>
  (note?.types || []).some((type) => normalizeType(type) === 'meeting_minutes');

const SECTION = /^ {0,3}##[ \t]+(.+?)\s*$/;
const TONES = new Map([
  ['decisions', 'decisions'],
  ['action items', 'actions'],
  ['open questions', 'questions'],
]);

export function parseMeetingMinutes(content) {
  const sections = [];
  const lead = [];
  let body = lead;
  let skippedTitle = false;
  for (const { text, plain } of lines(content)) {
    const heading = plain ? SECTION.exec(text) : null;
    const name = heading?.[1].replace(/[ \t]+#+$/, '').trim();
    if (name) {
      body = [];
      sections.push({ name, body, tone: TONES.get(sectionKey(name)) || '' });
    } else if (plain && !skippedTitle && /^#\s+\S/.test(text)) {
      skippedTitle = true;
    } else {
      body.push(text);
    }
  }

  return {
    lead: trimBlank(lead).join('\n'),
    sections: sections.map((section) => ({ ...section, body: trimBlank(section.body).join('\n') })),
  };
}

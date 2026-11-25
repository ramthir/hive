import { normalizeType } from '/static/type-icons.js';
import { lines, sectionKey, trimBlank } from '/static/specifications/specification-note.js';

export const isMeetingMinutesNote = (note) =>
  (note?.types || []).some((type) => normalizeType(type) === 'meeting_minutes');

const SECTION = /^ {0,3}##[ \t]+(.+?)\s*$/;
const TONES = new Map([
  ['decisions', 'decisions'],
  ['key decision points', 'decision-points'],
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

const MINUTES_LINK = /^ {0,3}[-*+]\s+(\[\[([^\]|]+)(?:\|([^\]]*))?\]\])\s*$/;
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const DATE_SUFFIX = new RegExp(`(?:^|\\s)(${MONTHS.join('|')}) (\\d{1,2}), (\\d{4})$`, 'i');

function minutesDate(target) {
  const match = DATE_SUFFIX.exec(target.trim());
  if (!match) {
    const iso = /(?:^|[\s-])(\d{4}-\d{2}-\d{2})$/.exec(target.trim())?.[1];
    const date = new Date(iso);
    return iso && Number.isFinite(date.getTime()) && date.toISOString().startsWith(iso) ? date.getTime() : null;
  }
  const [, month, day, year] = match;
  const monthIndex = MONTHS.findIndex((name) => name.toLowerCase() === month.toLowerCase());
  const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
  return date.getUTCMonth() === monthIndex ? date.getTime() : null;
}

export function meetingArchive(body) {
  const rows = body.split('\n').filter((line) => line.trim()).map((line) => MINUTES_LINK.exec(line));
  // Rich Markdown sections keep their original layout and content.
  if (!rows.length || rows.some((row) => !row)) return [];
  return rows.map(([, link, destination, alias]) => {
    const target = destination.split('#', 1)[0];
    return { link, destination, label: alias || target, date: minutesDate(target) ?? minutesDate(alias || '') };
  }).sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
}

export function meetingParticipants(body) {
  const rows = body.split('\n').filter((line) => line.trim()).map((line) =>
    /^ {0,3}[-*+]\s+(\[\[[^\]]+\]\])(?:\s+<([^\s<>]+@[^\s<>]+)>)?\s*$/.exec(line));
  if (!rows.length || rows.some((row) => !row)) return [];
  return rows.map(([, link, email]) => ({ link, email }));
}

export function actionProgress(body) {
  const progress = { done: 0, total: 0 };
  for (const { text, plain } of lines(body)) {
    const task = plain && /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+/.exec(text);
    if (!task) continue;
    progress.total++;
    if (task[1] !== ' ') progress.done++;
  }
  return progress;
}

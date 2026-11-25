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
  ['agenda', 'agenda'],
  ['discussion', 'discussion'],
  ['notes', 'discussion'],
  ['next steps', 'next'],
]);

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;

/** Section names are shown without emoji (the file keeps them); a name made only of emoji is kept as written. */
export const withoutEmoji = (name) => name.replace(/[0-9#*]\ufe0f?\u20e3/g, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim() || name;

export function parseMeetingMinutes(content) {
  const sections = [];
  const lead = [];
  let body = lead;
  let skippedTitle = false;
  for (const { text, plain } of lines(content)) {
    const heading = plain ? SECTION.exec(text) : null;
    const name = heading && withoutEmoji(heading[1].replace(/[ \t]+#+$/, '').trim());
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

// An action item is a top-level list item of the Action Items section. One without a [ ] box is simply not done yet.
const ACTION_ITEM = /^ ?(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\](?=\s|$))?/;

export function actionProgress(body) {
  const progress = { done: 0, total: 0 };
  for (const { text, plain } of lines(body)) {
    const item = plain && ACTION_ITEM.exec(text);
    if (!item) continue;
    progress.total++;
    if (item[1] && item[1] !== ' ') progress.done++;
  }
  return progress;
}

/**
 * The note's text with action item number `index` (in file order, across the Action Items sections) marked done or not done.
 * An item without a box gets one when it is marked done. Null when there is no such item.
 */
export function toggleAction(content, index, done) {
  const raw = String(content ?? '').split('\n');
  let tone = '';
  let seen = 0;
  let at = 0;
  for (const { text, plain } of lines(content)) {
    const heading = plain && SECTION.exec(text);
    if (heading) {
      tone = TONES.get(sectionKey(withoutEmoji(heading[1].replace(/[ \t]+#+$/, '').trim()))) || '';
    } else if (plain && tone === 'actions') {
      const item = ACTION_ITEM.exec(text);
      if (item) {
        if (seen === index) {
          const mark = done ? '[x]' : '[ ]';
          raw[at] = item[1] === undefined
            ? raw[at].replace(/^( ?(?:[-*+]|\d+[.)])\s+)/, `$1${done ? '[x] ' : ''}`)
            : raw[at].replace(/\[[ xX]\]/, mark);
          return raw.join('\n');
        }
        seen++;
      }
    }
    at++;
  }
  return null;
}

const DAY = 86400000;

function relativeDay(days) {
  if (days === 0) return 'today';
  const past = days < 0;
  const n = Math.abs(days);
  if (n === 1) return past ? 'yesterday' : 'tomorrow';
  const [count, unit] = n < 14 ? [n, 'days'] : n < 60 ? [Math.round(n / 7), 'weeks']
    : n < 730 ? [Math.round(n / 30), 'months'] : [Math.round(n / 365), 'years'];
  return past ? `${count} ${unit} ago` : `in ${count} ${unit}`;
}

/**
 * How a row of the Minutes list reads: the date leads ("Wednesday, November 18, 2026"), what is left of the title (without the
 * word "Minutes" and the date) follows dimmed, and `ago` says how far away it is. A row without a date keeps its title.
 */
export function minutesRow({ label, date }, now = Date.now()) {
  if (date === null) return { title: label, subtitle: '', ago: '' };
  const title = new Date(date).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const subtitle = label
    .replace(DATE_SUFFIX, '')
    .replace(/(?:^|[\s-])\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^\s*minutes\b[\s\-—–:,]*/i, '')
    .replace(/[\s\-—–:,]+$/, '')
    .trim();
  const today = Math.floor(now / DAY) * DAY;
  return { title, subtitle, ago: relativeDay(Math.round((date - today) / DAY)) };
}

/** "Wednesday, November 18, 2026" for a minutes title that ends in a date (written out or 2026-11-18), else ''. */
export function shortMinutesDate(title) {
  const date = minutesDate(String(title ?? ''));
  return date === null ? '' : new Date(date).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

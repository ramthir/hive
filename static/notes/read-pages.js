import { isMeetingMinutesNote } from '/static/meeting-minutes/meeting-minutes-note.js';
import { isTableNote } from '/static/tables/table-note.js';
import { isTimelineNote } from '/static/timelines/timeline-note.js';
import { isSpecificationNote } from '/static/specifications/specification-note.js';
import { isTaskNote } from '/static/task-notes/task-note.js';

/* Note types that are read on their own page instead of the note page's preview.
   Add a type here, a page script built with `defineReadPage` and a route in src/api/main.py (READ_PAGES). */
export const READ_PAGES = [
  { type: 'table', path: '/tables', matches: isTableNote },
  { type: 'timeline', path: '/timelines', matches: isTimelineNote },
  { type: 'specification', path: '/specifications', matches: isSpecificationNote },
  { type: 'task', path: '/tasks', matches: isTaskNote },
  { type: 'meeting_minutes', path: '/meeting-minutes', matches: isMeetingMinutesNote },
];

/** The address a note is read at, or '' when the note page shows it. */
export function readPagePath(note) {
  if (!note?.slug) return '';
  const page = READ_PAGES.find((candidate) => candidate.matches(note));
  return page ? `${page.path}/${encodeURIComponent(note.slug)}` : '';
}

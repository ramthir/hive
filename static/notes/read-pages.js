import { normalizeType } from '/static/type-icons.js';
import { isMeetingMinutesNote } from '/static/meeting-minutes/meeting-minutes-note.js';
import { isTableNote } from '/static/tables/table-note.js';
import { isTimelineNote } from '/static/timelines/timeline-note.js';
import { isSpecificationNote } from '/static/specifications/specification-note.js';
import { isTaskNote } from '/static/task-notes/task-note.js';

const meetingStyles = [
  '/static/components/combobox.css',
  '/static/components/date-picker.css',
  '/static/components/duration-picker.css',
  '/static/notes/menu.css',
  '/static/notes/embeds.css',
  '/static/notes/read-sections.css',
  '/static/meeting-minutes/meeting-minutes.css',
];

// Ordered by precedence for notes with more than one type.
export const READ_PAGES = [
  {
    type: 'table', path: '/tables', matches: isTableNote,
    load: () => import('/static/tables/tables-registration.js'),
    styles: [
      '/static/components/table.css',
      '/static/components/combobox.css',
      '/static/components/date-picker.css',
      '/static/components/duration-picker.css',
      '/static/tables/tables.css',
    ],
  },
  {
    type: 'timeline', path: '/timelines', matches: isTimelineNote,
    load: () => import('/static/timelines/timelines-registration.js'),
    styles: ['/static/timelines/timelines.css'],
  },
  {
    type: 'specification', path: '/specifications', matches: isSpecificationNote,
    load: () => import('/static/specifications/specifications-registration.js'),
    styles: [
      '/static/notes/menu.css',
      '/static/notes/embeds.css',
      '/static/notes/read-sections.css',
      '/static/specifications/specifications.css',
    ],
  },
  {
    type: 'task', path: '/tasks', matches: isTaskNote,
    load: () => import('/static/task-notes/task-note-registration.js'),
    styles: [
      '/static/components/combobox.css',
      '/static/components/date-picker.css',
      '/static/components/duration-picker.css',
      '/static/notes/menu.css',
      '/static/notes/embeds.css',
      '/static/notes/read-sections.css',
      '/static/task-notes/task-note.css',
    ],
  },
  {
    type: 'meeting_minutes', path: '/meeting-minutes', matches: isMeetingMinutesNote,
    load: () => import('/static/meeting-minutes/meeting-minutes-registration.js'),
    styles: meetingStyles,
  },
  {
    type: 'meeting',
    path: '/meetings',
    styles: meetingStyles,
    load: () => import('/static/meeting-minutes/meeting-minutes-registration.js'),
    matches: (note) => (note?.types || []).some((type) => normalizeType(type) === 'meeting'),
  },
];

/** The address a note is read at, or '' when the note page shows it. */
export function readPagePath(note) {
  if (!note?.slug) return '';
  const page = READ_PAGES.find((candidate) => candidate.matches(note));
  return page ? `${page.path}/${encodeURIComponent(note.slug)}` : '';
}

/** Select a Note View by URL, independently of the note's type precedence. */
export function noteViewForPath(pathname) {
  return READ_PAGES.find(({ path }) => pathname.startsWith(`${path}/`));
}

/** Pure logic of the time entries page: the table, the search address, the save plan. No DOM, so it is unit-tested. */
import { MAX_MINUTES, formatDay, formatDuration, isDay } from './format.js';

export const PAGE_SIZE = 10;
export const SEARCH_HELP =
  'Filters: project:Name, task:Name, date:today, date:yesterday, date:YYYY-MM-DD, duration:>30m (also <, >=, <=, 1h-2h)';

/**
 * The notes minutes can be logged on, as combobox options in the order the server sent (this week's first). Each
 * carries its type's icon and, once this week's notes are followed by others, a heading above each group.
 */
export function timeNoteOptions(notes) {
  const list = notes || [];
  const split = list.some((n) => n.this_week) && list.some((n) => !n.this_week);
  return list.map((n) => ({
    value: n.slug,
    label: n.title,
    icon: `fa-solid ${n.type === 'meeting' ? 'fa-calendar-check' : 'fa-list-check'}`,
    ...(split ? { group: n.this_week ? 'This week' : 'Earlier' } : {}),
  }));
}

/** `?q=…&page=2` -> the page state. The address counts pages from 1, the API from 0. */
export function readState(search) {
  const params = new URLSearchParams(search);
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return { q: params.get('q') ?? '', page: Number.isFinite(page) && page > 1 ? page - 1 : 0 };
}

export function stateSearch({ q, page }) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (page > 0) params.set('page', String(page + 1));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The API query for a page state. */
export function listQuery({ q, page }, pageSize = PAGE_SIZE) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (q) params.set('q', q);
  return params.toString();
}

const noteTime = (slug, day) => `/notes/${encodeURIComponent(slug)}/time/${encodeURIComponent(day)}`;

/**
 * The API calls that save the drawer. `record` is the row being edited (null when adding), `values` the form:
 * `{slug, day, minutes}`. Adding adds the minutes to the day (a day holds one total); editing a row in place sets
 * its minutes; moving it to another note or day adds the minutes there and removes the old row, so nothing that
 * was already logged on the target is lost. Throws for input the server would refuse; [] when nothing changed.
 */
export function savePlan(record, values) {
  const slug = String(values.slug ?? '').trim();
  const day = String(values.day ?? '').trim();
  const minutes = Number(values.minutes);
  if (!slug) throw new Error('Choose a task or meeting.');
  if (!isDay(day)) throw new Error('Choose a date.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new Error(`Choose a duration between 1 minute and ${MAX_MINUTES / 60} hours.`);
  if (!record) return [{ method: 'POST', path: `/notes/${encodeURIComponent(slug)}/time`, body: { day, minutes } }];
  const moved = record.slug !== slug || record.day !== day;
  if (!moved) return minutes === record.minutes ? [] : [{ method: 'PUT', path: noteTime(slug, day), body: { minutes } }];
  return [
    { method: 'POST', path: `/notes/${encodeURIComponent(slug)}/time`, body: { day, minutes } },
    { method: 'DELETE', path: noteTime(record.slug, record.day) },
  ];
}

export const deleteCall = (record) => ({ method: 'DELETE', path: noteTime(record.slug, record.day) });

/** Table columns; `render` returns trusted markup, so every value goes through `esc`. */
export function tableColumns(esc) {
  return [
    { key: 'day', label: 'Date', width: '11rem', render: (day) => esc(formatDay(day)) },
    {
      key: 'title',
      label: 'Task or meeting',
      render: (title, row) => `<i class="fa-solid ${row.type === 'meeting' ? 'fa-calendar-check' : 'fa-list-check'} time-type" title="${esc(row.type)}" aria-hidden="true"></i><span class="time-title">${esc(title)}</span> <a class="time-note-link" href="/notes/${encodeURIComponent(row.slug)}" title="Open note" aria-label="Open note: ${esc(title)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`,
    },
    { key: 'project', label: 'Project', render: (project) => (project ? esc(project) : '<span class="time-none">—</span>') },
    { key: 'minutes', label: 'Duration', width: '8rem', className: 'time-duration', render: (minutes) => esc(formatDuration(minutes)) },
  ];
}

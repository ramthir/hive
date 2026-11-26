import { escapeHtml as esc } from '../html.js';
import { parseTags } from '../notes/tags.js';
import { unwrapWikilink } from '../notes/markdown-sections.js';
import { formatDuration } from '../time-entries/format.js';

export { parseTags };

export const COLUMNS = Object.freeze([
  { value: 'TODO', label: 'To Do' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'DONE', label: 'Done' },
]);

export const noteHref = (task) => `/notes/${encodeURIComponent(task.slug)}`;

export const ALL_WEEKS = 'all';

/** `2026-W47`: the week a task belongs to, worked out by the server (its `week`, else its `updated` day); null if none. */
export const weekKey = (task) => task?.week_key ?? null;

/** A task's week for its chip: `{year, week, stored}` (stored: it was recorded, not guessed from `updated`), or null. */
export function taskWeek(task) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey(task) ?? ''));
  return m ? { year: +m[1], week: +m[2], stored: !!task.week_stored } : null;
}

/** `2026-W47` -> `Week 47 2026`, how Pandora names its weeks. */
export const weekTitle = (key) => {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key));
  return m ? `Week ${m[2]} ${m[1]}` : String(key);
};

export const isDoneWeekChoice = (value) => value === ALL_WEEKS || /^\d{4}-W\d{2}$/.test(String(value));

/**
 * What the Done column's week filter offers: every week with finished tasks, newest first with its count, this
 * week always (even with none yet), then "All weeks". `selected` is kept in the list even when it has no tasks
 * (a shared link to an empty week still shows what it is).
 */
export function doneWeekOptions(tasks, selected, current) {
  const counts = new Map();
  for (const task of tasks) {
    if (task.status !== 'DONE') continue;
    const key = weekKey(task);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const key of [current, selected]) if (key && key !== ALL_WEEKS && !counts.has(key)) counts.set(key, 0);
  const options = [...counts.keys()].sort().reverse().map((key) => ({ value: key, title: weekTitle(key), count: counts.get(key) }));
  options.push({ value: ALL_WEEKS, title: 'All weeks', count: tasks.filter((t) => t.status === 'DONE').length });
  return { options, selected };
}

/** The tasks the board shows: open ones always, finished ones only from the chosen week (or all weeks). */
export const visibleTasks = (tasks, doneWeek) =>
  doneWeek === ALL_WEEKS ? tasks : tasks.filter((task) => task.status !== 'DONE' || weekKey(task) === doneWeek);

// `todo` / `done` only restate the column the card is in.
const REDUNDANT_TAGS = ['todo', 'done'];

// "1 Must / 2 Important / 3 Nice to have": the server says which one a task has (`priority`, from its tags);
// this is only how each is drawn and ranked.
export const PRIORITIES = Object.freeze([
  { value: 'must', rank: 1, label: 'Must', cls: 'must', icon: 'fa-solid fa-flag' },
  { value: 'important', rank: 2, label: 'Important', cls: 'important', icon: 'fa-solid fa-flag' },
  { value: 'nice-to-have', rank: 3, label: 'Nice to have', cls: 'good-to-have', icon: 'fa-regular fa-flag' },
]);

export const taskPriority = (task) => PRIORITIES.find((p) => p.value === task?.priority) || null;

/** Most urgent first; tasks with the same priority (or none) keep their order. */
export const sortByPriority = (tasks) =>
  tasks
    .map((task, i) => [task, i])
    .sort(([a, i], [b, j]) => (taskPriority(a)?.rank ?? 4) - (taskPriority(b)?.rank ?? 4) || i - j)
    .map(([task]) => task);

const projectName = (task) => unwrapWikilink(task?.project);

const JIRA = 'https://socialedge.atlassian.net/browse/';

/** The Jira address of a task's ticket: only CreatorIQ tickets that look like `APIM-66` have one, otherwise ''. */
export function ticketUrl(task) {
  const ticket = String(task?.ticket ?? '').trim();
  return projectName(task || {}).toLowerCase() === 'creatoriq' && /^[a-z][a-z0-9_]*-\d+$/i.test(ticket) ? `${JIRA}${ticket.toUpperCase()}` : '';
}

function renderTicketChip(task) {
  const ticket = String(task.ticket ?? '').trim();
  if (!ticket) return '';
  const content = `<i class="fa-solid fa-ticket" aria-hidden="true"></i>${esc(ticket)}`;
  const url = ticketUrl(task);
  if (url) {
    return `<a class="board-chip board-chip--ticket board-chip--link" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${esc(ticket)} in Jira">${content}</a>`;
  }
  return `<span class="board-chip board-chip--ticket" title="Ticket ${esc(ticket)}">${content}</span>`;
}

export function renderCard(task) {
  const priority = taskPriority(task);
  const priorityChip = priority
    ? `<span class="board-chip board-chip--priority board-chip--${priority.cls}" title="Priority ${priority.rank}: ${priority.label}"><i class="${priority.icon}" aria-hidden="true"></i>${priority.label}</span>`
    : '';
  const project = projectName(task);
  const projectChip = project
    ? `<span class="board-chip board-chip--project"><i class="fa-solid fa-briefcase" aria-hidden="true"></i>${esc(project)}</span>`
    : '';
  const tags = (task.tags || [])
    .filter((tag) => {
      const key = String(tag).trim().replace(/^#/, '').toLowerCase();
      return !REDUNDANT_TAGS.includes(key) && key !== project.toLowerCase();
    })
    .map((tag) => `<span class="board-chip"><i class="fa-solid fa-tag" aria-hidden="true"></i>${esc(tag)}</span>`)
    .join('');
  const week = taskWeek(task);
  const weekChip = week
    ? `<span class="board-chip board-chip--week" title="${week.stored ? 'Finished' : 'Last updated'} in week ${week.week} of ${week.year}"><i class="fa-regular fa-calendar" aria-hidden="true"></i>W${week.week}</span>`
    : '';
  const logged = Number(task.logged_minutes) || 0;
  const loggedChip = logged > 0
    ? `<span class="board-chip board-chip--logged" title="${formatDuration(logged)} logged"><i class="fa-regular fa-clock" aria-hidden="true"></i>${formatDuration(logged)}</span>`
    : '';
  const details = `${priorityChip}${projectChip}${renderTicketChip(task)}${weekChip}${loggedChip}`;
  return `<div class="board-card-heading">
      <div class="board-card-title">${esc(task.title)}</div>
      <a class="board-card-note-link" href="${esc(noteHref(task))}" title="Open note" aria-label="Open note ${esc(task.title)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
    </div>
    ${details ? `<div class="board-card-chips">${details}</div>` : ''}
    ${tags ? `<div class="board-card-chips board-card-tags">${tags}</div>` : ''}`;
}




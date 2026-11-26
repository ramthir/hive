import { escapeHtml as esc } from '../html.js';
import { parseTags } from '../notes/tags.js';
import { unwrapWikilink } from '../notes/markdown-sections.js';
import { formatDuration } from '../time-entries/format.js';
import { renderHeaderChip } from '../components/page-header.js';
import { visibleTags } from '../task-notes/task-note.js';

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

const PRIORITY_TONE = { must: 'red', important: 'orange', 'nice-to-have': 'green' };

/**
 * The chips a task shows on its board card and on its own page, as `renderHeaderChip` descriptors, in this order:
 * priority, project, ticket, week, time logged, then the tags that say something new (not `todo`/`done`, a priority or
 * the project). Both places draw them with the same `.header-chip` styles (hive.css).
 */
export function taskChips(task) {
  const priority = taskPriority(task);
  const project = projectName(task || {});
  const ticket = String(task?.ticket ?? '').trim();
  const href = ticketUrl(task);
  const week = taskWeek(task);
  const logged = Number(task?.logged_minutes) || 0;
  return [
    priority && { label: priority.label, icon: priority.icon, tone: PRIORITY_TONE[priority.value], title: `Priority ${priority.rank}: ${priority.label}`, className: `task-priority--${priority.value}` },
    project && { label: project, icon: 'fa-solid fa-briefcase', tone: 'blue', className: 'task-project' },
    ticket && { label: ticket, icon: 'fa-solid fa-ticket', className: 'task-ticket', ...(href ? { href, tone: 'blue', title: `Open ${ticket} in Jira` } : { title: `Ticket ${ticket}` }) },
    week && { label: `W${week.week}`, icon: 'fa-regular fa-calendar', tone: 'purple', title: `${week.stored ? 'Finished' : 'Last updated'} in week ${week.week} of ${week.year}`, className: 'task-week' },
    logged > 0 && { label: formatDuration(logged), icon: 'fa-regular fa-clock', tone: 'green', title: `${formatDuration(logged)} logged`, className: 'task-logged' },
    ...visibleTags(task?.tags, project).map((tag) => ({ label: tag, icon: 'fa-solid fa-tag', tone: 'outline', className: 'task-tag' })),
  ].filter(Boolean);
}

export function renderCard(task) {
  const chips = taskChips(task).map(renderHeaderChip).join('');
  return `<div class="board-card-heading">
      <div class="board-card-title">${esc(task.title)}</div>
      <a class="board-card-note-link" href="${esc(noteHref(task))}" title="Open note" aria-label="Open note ${esc(task.title)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
    </div>
    ${chips ? `<div class="board-card-chips">${chips}</div>` : ''}`;
}

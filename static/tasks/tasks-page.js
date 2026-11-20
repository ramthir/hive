import { escapeHtml as esc } from '/static/html.js';
import '/static/components/dropdown-menu.js';
import { showToast } from '/static/toast.js';
import { COLUMNS, ALL_WEEKS, currentWeekKey, doneWeekOptions, isDoneWeekChoice, renderCard, sortByPriority, visibleTasks } from '/static/tasks/card.js';
import { createTaskDrawer } from '/static/tasks/drawer.js';
import { SPOTLIGHT_SELECT_EVENT } from '/static/components/note-spotlight.js';

const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const searchShortcutKey = isMac ? '⌘K' : 'Ctrl+K';
const VARIANTS = Object.freeze({ TODO: 'todo', IN_PROGRESS: 'in-progress', DONE: 'done' });
// A column shows this many cards until "Show N more" is pressed: the Done column grows without bound.
const COLUMN_LIMITS = Object.freeze({ DONE: 12 });

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(typeof detail.detail === 'string' ? detail.detail : `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

class TasksApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <section class="tasks-page">
        <app-header heading="Tasks" variant="flush" attached>
          <div slot="actions" class="tasks-header-actions notes-header-actions app-header-action-group">
            <button id="search-notes-btn" class="notes-btn" type="button" title="Search notes (${searchShortcutKey})" aria-label="Search notes">
              <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>Search</span><kbd class="notes-btn-key">${searchShortcutKey}</kbd>
            </button>
          </div>
        </app-header>
        <div class="tasks-board-wrap"><app-board id="tasks-board"></app-board></div>
        <div class="task-drawer-host"></div>
      </section>`;
    this.doneWeek = this.readDoneWeek();
    this.querySelector('#search-notes-btn').addEventListener('click', () => document.querySelector('note-spotlight')?.open());
    this.board = this.querySelector('app-board');
    this.drawer = createTaskDrawer({ host: this.querySelector('.task-drawer-host'), onSave: (task, changes) => this.edit(task, changes) });
    this.board.configure({
      columns: COLUMNS,
      groupKey: (task) => task.status,
      itemId: (task) => task.slug,
      columnVariant: (value) => VARIANTS[value],
      columnLimits: COLUMN_LIMITS,
      renderCard,
      loading: true,
      onCardClick: (task) => this.drawer.open(task),
      onDrop: (task, status, previous) => this.move(task, status, previous),
    });
    this.board.addEventListener('board-error', (event) => showToast(event.detail.error.message, 'error'));
    this._spotlight = (event) => window.location.assign(`/notes/${encodeURIComponent(event.detail.slug)}`);
    window.addEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
  }

  // `?done=2026-W47` (or `all`) names the week the Done column shows; a bare /tasks shows this week.
  readDoneWeek() {
    const choice = new URLSearchParams(window.location.search).get('done');
    return isDoneWeekChoice(choice) ? choice : currentWeekKey();
  }

  setDoneWeek(choice) {
    this.doneWeek = choice;
    // The URL names the week (this week included), so a saved link keeps showing the week it was made for.
    const url = new URL(window.location.href);
    url.searchParams.set('done', choice);
    history.replaceState(null, '', url);
    this.refresh();
  }

  refresh() {
    this.board.setData(sortByPriority(visibleTasks(this.tasks, this.doneWeek)));
    this.renderDoneFilter();
  }

  // Pandora's pill in the Done column header, just before the count badge: shows the chosen week, the list has counts.
  // The board redraws its columns on every setData, so the pill is put back after each one.
  renderDoneFilter() {
    const header = this.board.querySelector('[data-column-value="DONE"] .board-column-header');
    if (!header) return;
    const { options, selected } = doneWeekOptions(this.tasks, this.doneWeek);
    const label = options.find((option) => option.value === selected)?.title ?? selected;
    const menu = document.createElement('app-dropdown-menu');
    menu.className = 'work-done-filter';
    menu.setAttribute('placement', 'bottom-end');
    menu.innerHTML = `<button slot="trigger" type="button" class="work-done-filter-btn" aria-label="Show Done tasks from: ${esc(label)}" title="Show Done tasks from"><span>${esc(label)}</span></button>
      <div slot="menu" class="app-dropdown-popup work-done-filter-menu">${options
        .map((option) => `<button type="button" class="app-dropdown-item" role="menuitemradio" aria-checked="${option.value === selected}" aria-label="${esc(option.title)} (${option.count})" data-action="${esc(option.value)}"><span>${esc(option.title)}</span><span class="board-column-count work-done-filter-count">${option.count}</span></button>`)
        .join('')}</div>`;
    menu.addEventListener('dropdown-select', (event) => this.setDoneWeek(event.detail.action));
    const count = header.querySelector('.board-column-count');
    if (count) count.before(menu);
    else header.append(menu);
  }

  async load() {
    try {
      this.tasks = await api('/tasks');
      // A bare /tasks shows this week's Done tasks, so the address says so (replacing the entry, not adding one).
      if (new URLSearchParams(window.location.search).has('done')) this.refresh();
      else this.setDoneWeek(this.doneWeek);
    } catch (error) {
      this.querySelector('.tasks-board-wrap').innerHTML = `<p class="tasks-error" role="alert">Could not load tasks: ${esc(error.message)}</p>`;
    }
  }

  // Saved from the drawer: one PUT (one commit); a new title renames the note, so the slug is taken from the reply.
  async edit(task, changes) {
    const saved = await api(`/notes/${encodeURIComponent(task.slug)}`, { method: 'PUT', body: changes });
    Object.assign(task, { slug: saved.slug, title: saved.title, tags: saved.tags, status: saved.status, week: saved.week, updated: saved.updated });
    this.refresh();
  }

  // Optimistic: the card jumps columns at once; if the save fails it goes back and the error is shown.
  // Finishing a task puts it in this week (the server does the same), so it does not vanish from an older week's view.
  async move(task, status, previous) {
    const previousWeek = task.week;
    task.status = status;
    task.week = status === 'DONE' ? currentWeekKey() : null;
    this.refresh();
    try {
      const saved = await api(`/notes/${encodeURIComponent(task.slug)}`, { method: 'PUT', body: { status } });
      task.status = saved.status;
      task.updated = saved.updated;
      task.week = saved.week;
    } catch (error) {
      task.status = previous;
      task.week = previousWeek;
      throw error;
    } finally {
      this.refresh();
    }
  }
}

if (!customElements.get('tasks-app')) customElements.define('tasks-app', TasksApp);

import { escapeHtml as esc } from '/static/html.js';
import '/static/components/dropdown-menu.js';
import { api } from '/static/notes/api.js';
import { showToast } from '/static/toast.js';
import { debounce, watchChanges } from '/static/events.js';
import { COLUMNS, doneWeekOptions, isDoneWeekChoice, renderCard, sortByPriority, visibleTasks } from '/static/tasks/card.js';
import { openProperties } from '/static/notes/properties.js';
import { SPOTLIGHT_SELECT_EVENT } from '/static/components/note-spotlight.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';

const VARIANTS = Object.freeze({ TODO: 'todo', IN_PROGRESS: 'in-progress', DONE: 'done' });
// A column shows this many cards until "Show N more" is pressed: the Done column grows without bound.
const COLUMN_LIMITS = Object.freeze({ DONE: 12 });

class TasksApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <section class="tasks-page">
        <app-header heading="Tasks" variant="flush" attached>
          <div slot="actions" class="tasks-header-actions notes-header-actions app-header-action-group">
            ${renderSearchTrigger()}
          </div>
        </app-header>
        <div class="tasks-board-wrap"><app-board id="tasks-board"></app-board></div>
      </section>`;
    wireSearchTrigger(this);
    this.board = this.querySelector('app-board');
    this.board.configure({
      columns: COLUMNS,
      groupKey: (task) => task.status,
      itemId: (task) => task.slug,
      columnVariant: (value) => VARIANTS[value],
      columnLimits: COLUMN_LIMITS,
      renderCard,
      loading: true,
      onCardClick: (task) => openProperties(task, { onSaved: () => this.reloadTasks().catch((error) => showToast(error.message, 'error')) }),
      onDrop: (task, status, previous) => this.move(task, status, previous),
    });
    this.board.addEventListener('board-error', (event) => showToast(event.detail.error.message, 'error'));
    this._spotlight = (event) => window.location.assign(`/notes/${encodeURIComponent(event.detail.slug)}`);
    window.addEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
    this.load();
    // Task notes changed in another tab or outside Hive (an editor, git pull): ask the server again. Not while a card is mid-move.
    this._reload = debounce(() => { if (!this._moving) this.reloadTasks().catch(() => {}); }, 400);
    this._changes = watchChanges({ type: 'task' }, this._reload);
  }

  disconnectedCallback() {
    this._changes?.close();
    this._reload?.cancel();
    window.removeEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
  }

  // `?done=2026-W47` (or `all`) names the week the Done column shows; a bare /tasks shows this week.
  readDoneWeek() {
    const choice = new URLSearchParams(window.location.search).get('done');
    return isDoneWeekChoice(choice) ? choice : this.currentWeek;
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
    const { options, selected } = doneWeekOptions(this.tasks, this.doneWeek, this.currentWeek);
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
      const [tasks, { week }] = await Promise.all([api('/tasks'), api('/tasks/current-week')]);
      this.tasks = tasks;
      this.currentWeek = week;
      this.doneWeek = this.readDoneWeek();
      // A bare /tasks shows this week's Done tasks, so the address says so (replacing the entry, not adding one).
      if (new URLSearchParams(window.location.search).has('done')) this.refresh();
      else this.setDoneWeek(this.doneWeek);
    } catch (error) {
      this.querySelector('.tasks-board-wrap').innerHTML = `<p class="tasks-error" role="alert">Could not load tasks: ${esc(error.message)}</p>`;
    }
  }

  // After a save the server is asked again: it owns status, week and slug, so nothing is worked out here.
  async reloadTasks() {
    this.tasks = await api('/tasks');
    this.refresh();
  }

  // Optimistic: the card jumps columns at once; if the save fails it goes back and the error is shown.
  // A finished task is shown in this week meanwhile, so it does not vanish from an older week's view.
  async move(task, status, previous) {
    const before = { ...task };
    this._moving = true;
    Object.assign(task, { status, ...(status === 'DONE' ? { week_key: this.currentWeek, week_stored: true } : {}) });
    this.refresh();
    try {
      await api(`/notes/${encodeURIComponent(task.slug)}`, { method: 'PUT', body: { status } });
    } catch (error) {
      Object.assign(task, before, { status: previous });
      this.refresh();
      throw error;
    } finally {
      this._moving = false;
    }
    await this.reloadTasks().catch(() => {}); // the move is saved; if the reload fails the optimistic card stays
  }
}

if (!customElements.get('tasks-app')) customElements.define('tasks-app', TasksApp);

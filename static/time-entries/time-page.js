import { escapeHtml as esc } from '/static/html.js';
import '/static/components/table.js';
import '/static/components/stat-card.js';
import '/static/components/activity-sparkline.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import '/static/components/pagination.js';
import '/static/components/combobox.js';
import '/static/components/date-picker.js';
import '/static/components/duration-picker.js';
import { createCrudDrawer } from '/static/components/crud-drawer.js';
import { debounce } from '/static/components/drawer-sync.js';
import { api } from '/static/notes/api.js';
import { showToast } from '/static/toast.js';
import {
  PAGE_SIZE, SEARCH_HELP, deleteCall, listQuery, readState, savePlan, stateSearch, tableColumns, timeNoteOptions,
} from '/static/time-entries/entries.js';
import { today } from '/static/time-entries/format.js';
import { summaryTiles } from '/static/time-entries/summary.js';
import { entryHint } from '/static/time-entries/logged.js';

const EMPTY = { icon: 'fa-clock', title: 'No time entries found', subtitle: 'Add time to a task or meeting, or adjust your search.' };

class TimeEntriesApp extends HTMLElement {
  connectedCallback() {
    this.state = readState(window.location.search);
    this.loadSeq = 0; // the latest load wins: an older answer is dropped
    this.innerHTML = `
      <section class="time-page">
        <app-header heading="Time Entries" variant="flush" attached>
          <div slot="actions" class="time-header-actions notes-header-actions app-header-action-group">
            <input class="time-search" type="search" placeholder="Search time entries" aria-label="Search time entries" title="${esc(SEARCH_HELP)}" value="${esc(this.state.q)}" autocomplete="off" />
            <button type="button" class="primary" data-add><i class="fa-solid fa-plus" aria-hidden="true"></i> Add time</button>
          </div>
        </app-header>
        <div class="time-body">
          <section class="time-summary" aria-label="Time entry summary"></section>
          <div class="table-card"><app-table clickable-rows aria-label="Time entries"></app-table></div>
          <app-pagination class="time-pagination"></app-pagination>
        </div>
        <div class="time-drawer-host"></div>
      </section>`;
    this.table = this.querySelector('app-table');
    this.pagination = this.querySelector('app-pagination');
    this.table.setColumns(tableColumns(esc));
    this.table.setEmptyState(EMPTY);
    this.table.setLoading(true);
    this.renderSummary({}, { loading: true });

    this.table.addEventListener('row-click', (event) => this.drawer.open(event.detail.rowData));
    this.pagination.addEventListener('page-change', (event) => this.go({ ...this.state, page: event.detail.page }));
    this.querySelector('[data-add]').addEventListener('click', () => this.drawer.open(null));
    const search = this.querySelector('.time-search');
    const apply = debounce(() => this.go({ q: search.value.trim(), page: 0 }), 250);
    search.addEventListener('input', apply);

    this.drawer = this.createDrawer();
    this.loadNotes();
    this.load();
    // notes created or retitled in another tab: refresh the picker when this page is shown again
    document.addEventListener('visibilitychange', this.onVisible = () => {
      if (!document.hidden) { this.loadNotes(); this.load(); }
    });
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  go(state) {
    this.state = state;
    history.replaceState(null, '', `${window.location.pathname}${stateSearch(state)}`);
    this.load();
  }

  async load() {
    const seq = ++this.loadSeq;
    try {
      const data = await api(`/time-entries?${listQuery(this.state)}`);
      if (seq !== this.loadSeq) return; // a newer search is already on its way
      this.table.setData(data.items);
      this.renderSummary(data);
      this.pagination.setAttribute('page', String(data.page));
      this.pagination.setAttribute('total-pages', String(data.total_pages));
      this.pagination.setAttribute('total-items', String(data.total));
      this.pagination.setAttribute('page-size', String(PAGE_SIZE));
      this.pagination.hidden = data.total <= PAGE_SIZE;
      if (data.page > 0 && !data.items.length && data.total) this.go({ ...this.state, page: data.total_pages - 1 });
    } catch (error) {
      if (seq === this.loadSeq) this.table.setError(`Could not load time entries: ${error.message}`);
    }
  }

  async loadNotes() {
    try {
      this.noteOptions = timeNoteOptions(await api('/time-notes'));
    } catch (error) {
      this.noteOptions = [];
      showToast(`Could not load notes: ${error.message}`, 'error');
    }
  }

  // Pandora's stat cards; `loading` shows their skeleton until the first answer.
  renderSummary(meta, { loading = false } = {}) {
    this.querySelector('.time-summary').innerHTML = summaryTiles(meta)
      .map((tile) => {
        const { sparkline } = tile;
        const slotHtml = sparkline
          ? `<activity-sparkline slot="visual" values="${esc(sparkline.values.join(','))}" start="${esc(sparkline.start)}" details="${esc(JSON.stringify(sparkline.details))}"></activity-sparkline>`
          : '';
        return renderStatCard({ ...tile, loading, attrs: { 'data-metric': tile.key }, slotHtml });
      })
      .join('');
  }

  // Say when the chosen note and day already hold time (saving adds to it). Fetched per choice: the page only has one
  // page of rows, so the note's own `time` map is the source.
  async showEntryHint(form) {
    const hint = form.querySelector('.log-time-hint');
    const { slug, day } = Object.fromEntries(new FormData(form));
    const record = this.drawer?.current() ?? null;
    const seq = (this.hintSeq = (this.hintSeq || 0) + 1);
    hint.textContent = '';
    if (!slug || !day) return;
    try {
      const note = await api(`/notes/${encodeURIComponent(slug)}`);
      if (seq === this.hintSeq) hint.textContent = entryHint(record, { slug, day }, note.time);
    } catch {
      /* the hint is a courtesy: saving reports real problems */
    }
  }

  createDrawer() {
    return createCrudDrawer({
      host: this.querySelector('.time-drawer-host'),
      singularLabel: 'Time Entry',
      initialFocus: '[name="slug"] .combobox-input',
      fieldsHtml: `<label class="field">Task or meeting<app-combobox name="slug" required placeholder="Search tasks and meetings"></app-combobox></label>
        <div class="time-form-row">
          <label class="field">Date<app-datepicker name="day" required></app-datepicker></label>
          <label class="field">Duration<app-durationpicker name="minutes" required></app-durationpicker></label>
        </div>
        <p class="log-time-hint" aria-live="polite"></p>`,
      populateForm: (record, form) => {
        const note = form.querySelector('app-combobox[name="slug"]');
        note.optionsList = this.noteOptions || [];
        note.value = record?.slug || '';
        form.querySelector('app-datepicker[name="day"]').value = record?.day || today();
        form.querySelector('app-durationpicker[name="minutes"]').value = record?.minutes || 60;
        if (!form.dataset.hintBound) {
          form.dataset.hintBound = '1';
          form.addEventListener('change', () => this.showEntryHint(form));
        }
        this.showEntryHint(form);
      },
      buildPayload: (form) => Object.fromEntries(new FormData(form)),
      onSave: async (values, record) => {
        for (const call of savePlan(record, values)) await api(call.path, { method: call.method, body: call.body });
        await Promise.all([this.load(), this.loadNotes()]);
      },
      onDelete: async (record) => {
        const call = deleteCall(record);
        await api(call.path, { method: call.method });
        await this.load();
      },
    });
  }
}

if (!customElements.get('time-entries-app')) customElements.define('time-entries-app', TimeEntriesApp);

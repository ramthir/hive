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
  PAGE_SIZE, SEARCH_HELP, deleteCall, listQuery, readState, savePlan, stateSearch, summaryTiles, tableColumns, timeNoteOptions, today,
} from '/static/time-entries/entries.js';

const EMPTY = { icon: 'fa-clock', title: 'No time entries found', subtitle: 'Add time to a task or meeting, or adjust your search.' };

class TimeEntriesApp extends HTMLElement {
  connectedCallback() {
    this.state = readState(window.location.search);
    this.rows = [];
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
  }

  go(state) {
    this.state = state;
    history.replaceState(null, '', `${window.location.pathname}${stateSearch(state)}`);
    this.load();
  }

  async load() {
    const seq = (this._seq = (this._seq || 0) + 1);
    try {
      const data = await api(`/time-entries?${listQuery(this.state)}`);
      if (seq !== this._seq) return; // a newer search is already on its way
      this.rows = data.items;
      this.table.setData(data.items);
      this.renderSummary(data);
      this.pagination.setAttribute('page', String(data.page));
      this.pagination.setAttribute('total-pages', String(data.total_pages));
      this.pagination.setAttribute('total-items', String(data.total));
      this.pagination.setAttribute('page-size', String(PAGE_SIZE));
      this.pagination.hidden = data.total <= PAGE_SIZE;
      if (data.page > 0 && !data.items.length && data.total) this.go({ ...this.state, page: data.total_pages - 1 });
    } catch (error) {
      if (seq === this._seq) this.table.setError(`Could not load time entries: ${error.message}`);
    }
  }

  async loadNotes() {
    try {
      this.noteOptions = timeNoteOptions(await api('/notes?limit=1000'));
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

  createDrawer() {
    return createCrudDrawer({
      host: this.querySelector('.time-drawer-host'),
      singularLabel: 'Time Entry',
      initialFocus: '[name="slug"] .combobox-input',
      fieldsHtml: `<label class="field">Task or meeting<app-combobox name="slug" required placeholder="Search tasks and meetings"></app-combobox></label>
        <div class="time-form-row">
          <label class="field">Date<app-datepicker name="day" required></app-datepicker></label>
          <label class="field">Duration<app-durationpicker name="minutes" required></app-durationpicker></label>
        </div>`,
      populateForm: (record, form) => {
        const note = form.querySelector('app-combobox[name="slug"]');
        note.optionsList = this.noteOptions || [];
        note.value = record?.slug || '';
        form.querySelector('app-datepicker[name="day"]').value = record?.day || today();
        form.querySelector('app-durationpicker[name="minutes"]').value = record?.minutes || 60;
      },
      buildPayload: (form) => Object.fromEntries(new FormData(form)),
      onSave: async (values, record) => {
        for (const call of savePlan(record, values)) await api(call.path, { method: call.method, body: call.body });
        await this.load();
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

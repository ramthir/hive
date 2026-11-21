import '/static/components/table.js';
import '/static/components/stat-card.js';
import '/static/components/pagination.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import { api } from '/static/notes/api.js';
import { containerSummary, processQuery, statTiles } from '/static/dashboard/format.js';
import { processColumns } from '/static/dashboard/process-columns.js';

const REFRESH_MS = 5000;
const PAGE_SIZE = 10;
const FILTER_DELAY_MS = 250; // typing asks the server once the person pauses
const CARD_ATTRS = { value: 'value', sub: 'sub', color: 'color', progress: 'progress', progressColor: 'progress-color', segments: 'segments', segmentColors: 'segment-colors' };

/** The Debian tab: what is running in the container Hive is in. */
class DebianTab extends HTMLElement {
  connectedCallback() {
    this.page = 1;
    this.sort = 'cpu_percent';
    this.direction = 'desc';
    this.q = '';
    this.seq = 0; // the latest process answer wins
    this.statsSeq = 0; // the latest stats answer wins
    this.hasProcesses = false;
    this.summaryText = '';
    this.matchCount = null;
    this.errors = { stats: '', processes: '' };
    this.innerHTML = `
      <div class="dash-body">
        <section class="dash-grid" aria-label="Container statistics"></section>
        <div class="proc-toolbar">
          <input type="search" class="proc-filter" aria-label="Filter processes" placeholder="Filter processes by name or command" autocomplete="off" />
          <span class="proc-meta" aria-live="polite"></span>
        </div>
        <div class="table-card"><app-table aria-label="Container processes"></app-table></div>
        <app-pagination hidden></app-pagination>
      </div>`;
    this.grid = this.querySelector('.dash-grid');
    this.table = this.querySelector('app-table');
    this.pagination = this.querySelector('app-pagination');
    this.filter = this.querySelector('.proc-filter');
    this.meta = this.querySelector('.proc-meta');
    this.table.setAttribute('sort-mode', 'server');
    this.table.setColumns(this.columns());
    this.table.setDefaultSort('cpu_percent', 'desc');
    this.table.setEmptyState({ icon: 'fa-microchip', title: 'No process data available' });
    this.table.setLoading(true);
    this.grid.innerHTML = [1, 2, 3, 4].map((n) => renderStatCard({ title: '--', value: '--', loading: true, attrs: { 'data-placeholder': n } })).join('');

    this.filter.addEventListener('input', () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.q = this.filter.value;
        this.page = 1;
        this.table.setEmptyState(this.emptyState());
        this.table.setLoading(true);
        this.loadProcesses();
      }, FILTER_DELAY_MS);
    });
    this.table.addEventListener('sort-change', ({ detail }) => {
      this.sort = detail.key === 'mem' ? 'mem_percent' : detail.key;
      this.direction = detail.dir;
      this.page = 1;
      this.table.setLoading(true);
      this.loadProcesses();
    });
    this.pagination.addEventListener('page-change', ({ detail }) => {
      this.page = detail.page + 1;
      this.table.setLoading(true);
      this.loadProcesses();
    });
    document.addEventListener('visibilitychange', this.onVisible = () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  disconnectedCallback() {
    clearTimeout(this.filterTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stop();
  }

  // Polls while the tab is shown: an idle tab costs the server nothing.
  start() {
    if (this.timer || document.hidden) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  refresh() {
    this.loadStats();
    this.loadProcesses();
  }

  async loadStats() {
    const seq = ++this.statsSeq;
    try {
      const stats = await api('/system/stats');
      if (seq !== this.statsSeq || !this.isConnected) return;
      this.renderTiles(statTiles(stats));
      this.summaryText = containerSummary(stats);
      this.renderMeta();
      this.errors.stats = '';
      this.refreshStatus();
    } catch (error) {
      if (seq !== this.statsSeq || !this.isConnected) return;
      this.errors.stats = `Could not read stats: ${error.message}`;
      this.refreshStatus();
    }
  }

  async loadProcesses() {
    const seq = ++this.seq;
    const query = processQuery({ page: this.page, pageSize: PAGE_SIZE, sort: this.sort, direction: this.direction, q: this.q });
    try {
      const data = await api(`/system/processes?${query}`);
      if (seq !== this.seq || !this.isConnected) return;
      this.page = data.page;
      this.hasProcesses = true;
      this.matchCount = this.q.trim() ? data.total : null;
      this.renderMeta();
      this.table.setData(data.processes);
      this.pagination.setAttribute('page', String(data.page - 1));
      this.pagination.setAttribute('page-size', String(data.page_size));
      this.pagination.setAttribute('total-items', String(data.total));
      this.pagination.setAttribute('total-pages', String(data.total_pages));
      this.pagination.hidden = data.total <= data.page_size;
      this.errors.processes = '';
      this.refreshStatus();
    } catch (error) {
      if (seq !== this.seq || !this.isConnected) return;
      if (!this.hasProcesses || this.table.hasAttribute('aria-busy')) {
        this.matchCount = null;
        this.renderMeta();
        this.pagination.hidden = true;
        this.table.setError(`Could not read processes: ${error.message}`);
      }
      if (this.hasProcesses) {
        this.errors.processes = `Could not refresh processes: ${error.message}`;
        this.refreshStatus();
      }
    }
  }

  renderMeta() {
    if (!this.meta) return;
    const parts = [this.summaryText];
    if (this.matchCount !== null) parts.push(`${this.matchCount} matching`);
    this.meta.textContent = parts.filter(Boolean).join(' · ');
  }

  refreshStatus() {
    const message = [this.errors.stats, this.errors.processes].filter(Boolean).join(' · ');
    this.setStatus(message, Boolean(message));
  }

  emptyState() {
    return this.q.trim() ? { icon: 'fa-magnifying-glass', title: 'No process matches the filter' } : { icon: 'fa-microchip', title: 'No process data available' };
  }

  // The page's header shows the status line, so it is sent up rather than drawn here.
  setStatus(text, isError = false) {
    this.dispatchEvent(new CustomEvent('tab-status', { bubbles: true, detail: { text, error: isError } }));
  }

  // Cards are built once and then updated attribute by attribute, so a refresh does not flash or replay animations.
  renderTiles(tiles) {
    const keys = tiles.map((t) => t.key).join(',');
    if (this.grid.dataset.keys !== keys) {
      this.grid.dataset.keys = keys;
      this.grid.innerHTML = tiles.map((t) => renderStatCard({ ...t, attrs: { ...t.attrs, 'data-metric': t.key } })).join('');
      return;
    }
    for (const tile of tiles) {
      const card = this.grid.querySelector(`[data-metric="${tile.key}"]`);
      if (!card) continue;
      for (const [prop, attr] of Object.entries(CARD_ATTRS)) {
        if (tile[prop] !== undefined) card.setAttribute(attr, String(tile[prop]));
      }
      if (tile.attrs) {
        for (const [attr, val] of Object.entries(tile.attrs)) {
          if (val === true) card.setAttribute(attr, '');
          else if (val != null && val !== false) card.setAttribute(attr, String(val));
        }
      }
      if ((card.innerHTML || '') !== (tile.slotHtml || '')) card.innerHTML = tile.slotHtml || '';
    }
  }

  columns() {
    return processColumns({ threads: true, status: true });
  }
}

customElements.define('debian-tab', DebianTab);

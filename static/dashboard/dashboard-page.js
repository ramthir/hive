import { escapeHtml as esc } from '/static/html.js';
import '/static/components/table.js';
import '/static/components/stat-card.js';
import '/static/components/pagination.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import { api } from '/static/notes/api.js';
import { processColor, processTitle, statTiles } from '/static/dashboard/format.js';

const REFRESH_MS = 5000;
const PAGE_SIZE = 10;
const CARD_ATTRS = { value: 'value', sub: 'sub', progress: 'progress', progressColor: 'progress-color', segments: 'segments', segmentColors: 'segment-colors' };

class DashboardApp extends HTMLElement {
  connectedCallback() {
    this.page = 1;
    this.sort = 'cpu_percent';
    this.direction = 'desc';
    this.seq = 0; // the latest process answer wins
    this.innerHTML = `
      <section class="dash-page">
        <app-header heading="Dashboard" variant="flush" attached>
          <div slot="actions" class="notes-header-actions app-header-action-group">
            <span class="dash-status" role="status" aria-live="polite"></span>
          </div>
        </app-header>
        <div class="dash-body">
          <section class="dash-grid" aria-label="Container statistics"></section>
          <div class="table-card"><app-table aria-label="Container processes"></app-table></div>
          <app-pagination hidden></app-pagination>
        </div>
      </section>`;
    this.grid = this.querySelector('.dash-grid');
    this.status = this.querySelector('.dash-status');
    this.table = this.querySelector('app-table');
    this.pagination = this.querySelector('app-pagination');
    this.table.setAttribute('sort-mode', 'server');
    this.table.setColumns(this.columns());
    this.table.setDefaultSort('cpu_percent', 'desc');
    this.table.setEmptyState({ icon: 'fa-microchip', title: 'No process data available' });
    this.table.setLoading(true);
    this.grid.innerHTML = [1, 2, 3, 4].map((n) => renderStatCard({ title: '--', value: '--', loading: true, attrs: { 'data-placeholder': n } })).join('');

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
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stop();
  }

  // Polls while the tab is shown: an idle tab costs the server nothing.
  start() {
    if (this.timer) return;
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
    try {
      this.renderTiles(statTiles(await api('/system/stats')));
      this.setStatus(''); // nothing to say while it works; a failed read shows in the header until the next one succeeds
    } catch (error) {
      this.setStatus(`Could not read stats: ${error.message}`, true);
    }
  }

  async loadProcesses() {
    const seq = ++this.seq;
    const query = new URLSearchParams({ page: this.page, page_size: PAGE_SIZE, sort: this.sort, direction: this.direction });
    try {
      const data = await api(`/system/processes?${query}`);
      if (seq !== this.seq) return;
      this.page = data.page;
      this.table.setData(data.processes);
      this.pagination.setAttribute('page', String(data.page - 1));
      this.pagination.setAttribute('page-size', String(data.page_size));
      this.pagination.setAttribute('total-items', String(data.total));
      this.pagination.setAttribute('total-pages', String(data.total_pages));
      this.pagination.hidden = data.total <= data.page_size;
    } catch (error) {
      if (seq === this.seq) this.table.setError(`Could not read processes: ${error.message}`);
    }
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
  }

  // Cards are built once and then updated attribute by attribute, so a refresh does not flash or replay animations.
  renderTiles(tiles) {
    const keys = tiles.map((t) => t.key).join(',');
    if (this.grid.dataset.keys !== keys) {
      this.grid.dataset.keys = keys;
      this.grid.innerHTML = tiles.map((t) => renderStatCard({ ...t, attrs: { 'data-metric': t.key } })).join('');
      return;
    }
    for (const tile of tiles) {
      const card = this.grid.querySelector(`[data-metric="${tile.key}"]`);
      if (!card) continue;
      for (const [prop, attr] of Object.entries(CARD_ATTRS)) {
        if (tile[prop] !== undefined) card.setAttribute(attr, String(tile[prop]));
      }
      if ((card.innerHTML || '') !== (tile.slotHtml || '')) card.innerHTML = tile.slotHtml || '';
    }
  }

  columns() {
    const percent = (value) => `<span style="color:${processColor(value)}">${(Number(value) || 0).toFixed(1)}%</span>`;
    return [
      { key: 'name', label: 'Process', className: 'proc-cell',
        render: (_v, p) => `<span class="proc-label" title="${esc(processTitle(p))}"><span class="proc-name">${esc(p.name)}</span>${p.cmdline ? `<span class="proc-cmd">${esc(p.cmdline)}</span>` : ''}</span>` },
      { key: 'pid', label: 'PID', className: 'muted tabular', width: '5.5rem', render: (v) => esc(v) },
      { key: 'threads', label: 'Threads', className: 'muted tabular', width: '6rem', render: (v) => esc(v) },
      { key: 'running_for', label: 'Status', className: 'tabular', width: '8.5rem',
        render: (v) => `<span style="color:var(--color-green)">${esc(v ? `Up ${v}` : '--')}</span>` },
      { key: 'cpu_percent', label: 'CPU', className: 'tabular', width: '6rem', sortable: true, render: percent },
      { key: 'mem', label: 'Memory', className: 'tabular', width: '7.5rem', sortable: true,
        render: (v, row) => `<span title="${(Number(row.mem_percent) || 0).toFixed(1)}%">${esc(v || '—')}</span>` },
    ];
  }
}

customElements.define('dashboard-app', DashboardApp);

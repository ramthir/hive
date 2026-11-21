import '/static/components/table.js';
import '/static/components/pagination.js';
import '/static/components/stat-card.js';
import '/static/components/dropdown-menu.js';
import { escapeHtml as esc } from '/static/html.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import { api } from '/static/notes/api.js';
import { processColor, processTitle } from '/static/dashboard/format.js';
import { PAGE_SIZE, chooseSession, machineTiles, pickerItems, processPage, statusText, streamIsLive, usageTiles, uptimeTile } from '/static/colab/format.js';

const POLL_MS = 30000; // usage and the runtime list; the live numbers come from the stream
const CARD_ATTRS = { value: 'value', sub: 'sub', color: 'color', progress: 'progress', progressColor: 'progress-color' };

/**
 * The Colab tab: compute units, the active runtimes, and the selected runtime's live machine stats and processes.
 * The live numbers arrive on /api/colab/stream, which makes the server probe the runtime while this tab is open; closing the tab closes it.
 */
class ColabTab extends HTMLElement {
  connectedCallback() {
    this.session = null; // the selected runtime's name
    this.sessions = [];
    this.stats = null;
    this.processes = [];
    this.sort = 'cpu_percent';
    this.direction = 'desc';
    this.page = 0;
    this.innerHTML = `
      <div class="colab-body">
        <section class="colab-grid" data-grid="usage" aria-label="Colab usage">
          ${[['balance', 'fa-coins', 'Compute Units'], ['rate', 'fa-gauge-high', 'Usage Rate'], ['uptime', 'fa-clock', 'Uptime']]
            .map(([key, icon, title]) => renderStatCard({ title, icon, value: '-', sub: '-', loading: true, attrs: { 'data-metric': key } })).join('')}
          <stat-card data-metric="assignments" title="Active Assignments" icon="fa-server" value="-" sub="" allow-overflow loading>
            <app-dropdown-menu class="colab-picker" placement="bottom-start" hidden>
              <button slot="trigger" type="button" class="colab-picker-trigger" aria-label="Select Colab session">
                <span class="colab-picker-name"></span>
                <span class="colab-picker-runtime"><span></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></span>
              </button>
              <div slot="menu" class="app-dropdown-popup colab-picker-menu" role="menu" hidden></div>
            </app-dropdown-menu>
          </stat-card>
        </section>
        <div class="colab-idle" hidden>
          <i class="fa-solid fa-cloud" aria-hidden="true"></i>
          <h3>No active session</h3>
          <p>Start a runtime with <code>colab new</code> or <code>colab ssh</code> to view live VM metrics.</p>
        </div>
        <div class="colab-session" hidden>
          <section class="colab-grid" data-grid="machine" aria-label="Runtime statistics"></section>
          <div class="table-card"><app-table aria-label="Runtime processes"></app-table></div>
          <app-pagination hidden></app-pagination>
        </div>
      </div>`;
    this.usageGrid = this.querySelector('[data-grid="usage"]');
    this.machineGrid = this.querySelector('[data-grid="machine"]');
    this.idle = this.querySelector('.colab-idle');
    this.sessionPane = this.querySelector('.colab-session');
    this.picker = this.querySelector('.colab-picker');
    this.table = this.querySelector('app-table');
    this.pagination = this.querySelector('app-pagination');
    this.table.setAttribute('sort-mode', 'server');
    this.table.setColumns(this.columns());
    this.table.setDefaultSort(this.sort, this.direction);
    this.table.setEmptyState({ icon: 'fa-microchip', title: 'No process data available' });
    this.table.setLoading(true);
    this.drawMachine();

    this.picker.addEventListener('dropdown-select', ({ detail }) => {
      const name = detail.item?.dataset?.session;
      if (!name || name === this.session) return;
      this.select(name);
    });
    this.table.addEventListener('sort-change', ({ detail }) => {
      this.sort = detail.key;
      this.direction = detail.dir;
      this.page = 0;
      this.drawProcesses();
    });
    this.pagination.addEventListener('page-change', ({ detail }) => {
      this.page = detail.page;
      this.drawProcesses();
    });
    document.addEventListener('visibilitychange', this.onVisible = () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stop();
  }

  // Polls (and streams) only while the tab is shown: a hidden or closed tab makes the server stop probing the runtime.
  start() {
    if (this.timer || document.hidden) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.closeStream();
  }

  say(text, error = false) {
    this.dispatchEvent(new CustomEvent('tab-status', { bubbles: true, detail: { text, error } }));
  }

  async poll() {
    const [usage, sessions] = await Promise.allSettled([api('/colab/usage'), api('/colab/sessions')]);
    const errors = [];
    const usageData = usage.status === 'fulfilled' ? usage.value : null;
    const sessionData = sessions.status === 'fulfilled' ? sessions.value : null;
    if (!usageData) errors.push('Unable to read Colab usage');
    else if (usageData.reachable === false && usageData.error) errors.push(usageData.error);
    if (!sessionData) errors.push('Unable to read Colab sessions');
    else if (sessionData.reachable === false && sessionData.error) errors.push(sessionData.error);
    this.drawUsage(usageData);
    this.setSessions(Array.isArray(sessionData?.sessions) ? sessionData.sessions : []);
    if (this.session) this.openStream();
    else this.say([...new Set(errors)].join(' · '), errors.length > 0);
  }

  // --- cards ---------------------------------------------------------------------------------------------------------

  setCard(grid, tile) {
    const card = grid.querySelector(`[data-metric="${tile.key}"]`);
    if (!card) return;
    for (const [prop, attr] of Object.entries(CARD_ATTRS)) if (tile[prop] !== undefined) card.setAttribute(attr, String(tile[prop]));
    if (tile.loading) card.setAttribute('loading', '');
    else card.removeAttribute('loading');
  }

  drawUsage(usage) {
    for (const tile of usageTiles(usage)) this.setCard(this.usageGrid, tile);
  }

  get activeSession() {
    return this.sessions.find((s) => s.name === this.session) || null;
  }

  drawUptime() {
    this.setCard(this.usageGrid, uptimeTile(this.stats, this.activeSession, this.session));
  }

  // The machine cards are rebuilt only when the set of cards changes (a GPU appears), so a refresh does not flash.
  drawMachine() {
    const loading = !this.stats;
    const tiles = machineTiles(this.stats, this.activeSession);
    const keys = tiles.map((t) => t.key).join(',');
    if (this.machineGrid.dataset.keys !== keys) {
      this.machineGrid.dataset.keys = keys;
      this.machineGrid.innerHTML = tiles.map((t) => renderStatCard({ ...t, loading, attrs: { 'data-metric': t.key } })).join('');
      return;
    }
    for (const tile of tiles) this.setCard(this.machineGrid, { ...tile, loading });
  }

  // --- runtimes ------------------------------------------------------------------------------------------------------

  setSessions(sessions) {
    this.sessions = sessions;
    const chosen = chooseSession(sessions, this.session);
    if (chosen !== this.session) {
      this.session = chosen;
      this.stats = null;
      this.processes = [];
      this.page = 0;
      this.closeStream();
    }
    const has = Boolean(this.session);
    this.idle.hidden = has;
    this.sessionPane.hidden = !has;
    this.picker.hidden = !has;
    this.setCard(this.usageGrid, { key: 'assignments', loading: false, sub: has ? '' : 'No active session' });
    if (!has) {
      this.drawUptime();
      return;
    }
    this.drawPicker();
    this.drawUptime();
    this.drawMachine();
    this.drawProcesses();
  }

  select(name) {
    this.session = name;
    this.stats = null;
    this.processes = [];
    this.page = 0;
    this.closeStream();
    this.drawPicker();
    this.drawUptime();
    this.drawMachine();
    this.drawProcesses();
    this.openStream();
  }

  drawPicker() {
    const active = this.activeSession;
    if (!active) return;
    this.picker.querySelector('.colab-picker-name').textContent = active.name;
    this.picker.querySelector('.colab-picker-runtime span').textContent = active.runtime_id;
    this.picker.querySelector('.colab-picker-trigger').title = `${active.name} · ${active.runtime_id} · ${active.variant}`;
    const menu = this.picker.querySelector('.colab-picker-menu');
    const key = JSON.stringify(pickerItems(this.sessions, this.session));
    if (menu.dataset.key === key) return;
    menu.dataset.key = key;
    menu.innerHTML = pickerItems(this.sessions, this.session).map((item) => `
      <button type="button" class="app-dropdown-item${item.active ? ' active' : ''}" role="menuitem" data-session="${esc(item.name)}">
        <i class="${item.active ? 'fa-solid fa-check' : 'fa-regular fa-circle'}" aria-hidden="true"></i>
        <span class="dropdown-item-info"><span class="dropdown-item-header"><span class="dropdown-item-name">${esc(item.name)}</span><span class="dropdown-item-badge">${esc(item.variant)}</span></span>
        <span class="dropdown-item-runtime">${esc(item.runtime)}</span></span>
      </button>`).join('');
  }

  // --- the live stream -----------------------------------------------------------------------------------------------

  closeStream() {
    this.source?.close();
    this.source = null;
    this.streamed = null;
  }

  openStream() {
    const session = this.session;
    if (!session || document.hidden || !this.isConnected) return;
    if (streamIsLive(this.source, this.streamed, session)) return;
    this.closeStream();
    const source = new EventSource(`/api/colab/stream?session=${encodeURIComponent(session)}`);
    this.source = source;
    this.streamed = session;
    source.addEventListener('status', (event) => {
      if (this.source !== source || this.session !== session) return;
      try {
        this.apply(JSON.parse(event.data));
      } catch {
        this.say('Unable to read Colab status update.', true);
      }
    });
    source.onerror = () => {
      if (this.source !== source) return;
      const closed = source.readyState === EventSource.CLOSED; // closed for good: the next poll opens a new stream
      this.say(closed ? 'Live updates stopped; trying again shortly. Showing the last collected data.' : 'Live updates disconnected; reconnecting. Showing the last collected data.');
    };
  }

  apply(data) {
    if (data.session?.name !== this.session) return;
    if (data.status === 'loading') return this.say('');
    this.stats = data.stats || this.stats;
    this.processes = data.processes || [];
    this.drawMachine();
    this.drawUptime();
    this.drawProcesses();
    const { notice, error } = statusText(data);
    this.say(error || notice, Boolean(error));
  }

  // --- processes -----------------------------------------------------------------------------------------------------

  drawProcesses() {
    if (!this.stats && !this.processes.length) {
      this.table.setLoading(true);
      this.pagination.hidden = true;
      return;
    }
    const view = processPage(this.processes, { sort: this.sort, dir: this.direction, page: this.page, pageSize: PAGE_SIZE });
    this.page = view.page;
    this.table.setData(view.items);
    this.pagination.setAttribute('page', String(view.page));
    this.pagination.setAttribute('page-size', String(view.pageSize));
    this.pagination.setAttribute('total-items', String(view.total));
    this.pagination.setAttribute('total-pages', String(view.totalPages));
    this.pagination.hidden = view.total <= view.pageSize;
  }

  columns() {
    const percent = (value) => `<span style="color:${processColor(value)}">${(Number(value) || 0).toFixed(1)}%</span>`;
    return [
      { key: 'name', label: 'Process', className: 'proc-cell',
        render: (_v, p) => `<span class="proc-label" title="${esc(processTitle(p))}"><span class="proc-name">${esc(p.name)}</span>${p.cmdline ? `<span class="proc-cmd">${esc(p.cmdline)}</span>` : ''}</span>` },
      { key: 'pid', label: 'PID', className: 'muted tabular', width: '5.5rem', render: (v) => esc(v) },
      { key: 'running_for', label: 'Running', className: 'tabular', width: '8.5rem', render: (v) => `<span style="color:var(--color-green)">${esc(v || '--')}</span>` },
      { key: 'cpu_percent', label: 'CPU', className: 'tabular', width: '6rem', sortable: true, render: percent },
      { key: 'mem', label: 'Memory', className: 'tabular', width: '7.5rem', sortable: true,
        render: (v, row) => `<span title="${(Number(row.mem_percent) || 0).toFixed(1)}%">${esc(v || '—')}</span>` },
    ];
  }
}

customElements.define('colab-tab', ColabTab);

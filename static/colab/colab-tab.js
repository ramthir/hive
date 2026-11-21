import '/static/components/table.js';
import '/static/components/pagination.js';
import '/static/components/stat-card.js';
import '/static/components/dropdown-menu.js';
import { escapeHtml as esc } from '/static/html.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import { api } from '/static/notes/api.js';
import { processColumns } from '/static/dashboard/process-columns.js';
import { PAGE_SIZE, chooseSession, machineTiles, pickerItems, headerStatus, processPage, statusText, streamIsLive, waitingReason, usageTiles, uptimeTile } from '/static/colab/format.js';

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
    this.feed = null; // the last stream event: why there is no data yet
    this.stream = {}; // the stream's own notice or error for the header
    this.pollErrors = []; // what the usage and sessions reads say is wrong
    this.sort = 'cpu_percent';
    this.direction = 'desc';
    this.page = 0;
    this.q = '';
    this.innerHTML = `
      <div class="colab-body">
        <section class="colab-grid" data-grid="usage" aria-label="Colab usage">
          ${[['balance', 'fa-coins', 'Compute Units'], ['rate', 'fa-gauge-high', 'Usage Rate'], ['uptime', 'fa-clock', 'Uptime']]
            .map(([key, icon, title]) => renderStatCard({ title, icon, value: '-', sub: '-', loading: true, attrs: { 'data-metric': key } })).join('')}
          <stat-card data-metric="assignments" title="Active Assignments" icon="fa-server" value="-" sub="" allow-overflow loading>
            <app-dropdown-menu class="colab-picker" placement="bottom-end" hidden>
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
          <div class="colab-live" role="status" hidden>
            <span>Live updates are not running.</span>
            <button type="button" class="colab-reconnect"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Reconnect</button>
          </div>
          <section class="colab-grid" data-grid="machine" aria-label="Runtime statistics"></section>
          <div class="proc-toolbar">
            <input type="search" class="proc-filter" aria-label="Filter runtime processes" placeholder="Filter processes by name or command" autocomplete="off" />
            <span class="proc-meta" aria-live="polite"></span>
          </div>
          <div class="table-card"><app-table aria-label="Runtime processes"></app-table></div>
          <app-pagination hidden></app-pagination>
        </div>
      </div>`;
    this.usageGrid = this.querySelector('[data-grid="usage"]');
    this.machineGrid = this.querySelector('[data-grid="machine"]');
    this.idle = this.querySelector('.colab-idle');
    this.live = this.querySelector('.colab-live');
    this.sessionPane = this.querySelector('.colab-session');
    this.picker = this.querySelector('.colab-picker');
    this.table = this.querySelector('app-table');
    this.pagination = this.querySelector('app-pagination');
    this.filter = this.querySelector('.proc-filter');
    this.meta = this.querySelector('.proc-meta');
    this.table.setAttribute('sort-mode', 'server');
    this.table.setColumns(this.columns());
    this.table.setDefaultSort(this.sort, this.direction);
    this.table.setEmptyState({ icon: 'fa-microchip', title: 'No process data available' });
    this.table.setLoading(true);
    this.drawMachine();

    this.filter.addEventListener('input', () => {
      this.q = this.filter.value;
      this.page = 0;
      this.drawProcesses();
    });

    this.querySelector('.colab-reconnect').addEventListener('click', () => {
      this.closeStream();
      this.openStream();
    });
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

  // A stream that is down offers a way back now, instead of leaving the person to wait for the next poll.
  showLive(down) {
    if (this.live) this.live.hidden = !down;
  }

  // The header's line is composed from the stream and the polled reads, so neither hides the other.
  refreshStatus() {
    const { text, error } = headerStatus({ stream: this.stream, pollErrors: this.pollErrors });
    this.say(text, error);
  }

  async poll() {
    const [usage, sessions] = await Promise.allSettled([api('/colab/usage'), api('/colab/sessions')]);
    if (!this.isConnected) return;
    const errors = [];
    const usageData = usage.status === 'fulfilled' ? usage.value : null;
    const sessionData = sessions.status === 'fulfilled' ? sessions.value : null;
    const usageOk = Boolean(usageData && usageData.reachable !== false);
    const sessionsOk = Boolean(sessionData && sessionData.reachable !== false);
    if (!usageData) errors.push('Unable to read Colab usage');
    else if (usageData.reachable === false && usageData.error) errors.push(usageData.error);
    if (!sessionData) errors.push('Unable to read Colab sessions');
    else if (sessionData.reachable === false && sessionData.error) errors.push(sessionData.error);
    this.drawUsage(usageData);
    this.setSessions(Array.isArray(sessionData?.sessions) ? sessionData.sessions : [], {
      usageOk,
      sessionsOk,
      sessionsError: !sessionData ? 'Unable to read Colab sessions.' : (sessionData.error || ''),
    });
    this.pollErrors = errors;
    if (this.session) this.openStream();
    this.refreshStatus();
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
    const loading = Boolean(this.session) && !this.stats && !waitingReason(this.stats, this.feed);
    this.setCard(this.usageGrid, { ...uptimeTile(this.stats, this.activeSession, this.session), loading });
  }

  // The machine cards are rebuilt only when the set of cards changes (a GPU appears), so a refresh does not flash.
  drawMachine() {
    const loading = !this.stats && !waitingReason(this.stats, this.feed);
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

  setSessions(sessions, { usageOk = true, sessionsOk = true, sessionsError = '' } = {}) {
    this.sessions = sessions;
    const chosen = chooseSession(sessions, this.session);
    if (chosen !== this.session) {
      this.session = chosen;
      this.stats = null;
      this.processes = [];
      this.page = 0;
      this.q = '';
      if (this.filter) this.filter.value = '';
      this.closeStream();
    }
    const has = Boolean(this.session);
    this.idle.hidden = has;
    this.sessionPane.hidden = !has;
    this.picker.hidden = !has;
    if (!has) {
      const heading = this.idle.querySelector('h3');
      const body = this.idle.querySelector('p');
      if (sessionsOk) {
        heading.textContent = 'No active session';
        body.innerHTML = 'Start a runtime with <code>colab new</code> or <code>colab ssh</code> to view live VM metrics.';
      } else {
        heading.textContent = 'Unable to read Colab sessions';
        body.textContent = sessionsError || 'Check that the colab CLI is installed and signed in.';
      }
    }
    // Never clobber "Unable to read" on Active Assignments when `colab usage` failed.
    if (has) this.setCard(this.usageGrid, { key: 'assignments', loading: false, sub: '' });
    else if (usageOk) this.setCard(this.usageGrid, { key: 'assignments', loading: false, sub: 'No active session' });
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
    this.q = '';
    if (this.filter) this.filter.value = '';
    this.closeStream();
    this.refreshStatus();
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
    this.stream = {};
    this.feed = null;
    this.showLive(false);
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
        this.stream = { error: 'Unable to read Colab status update.' };
        this.refreshStatus();
      }
    });
    source.onerror = () => {
      if (this.source !== source) return;
      this.showLive(true);
      const closed = source.readyState === EventSource.CLOSED; // closed for good: the next poll opens a new stream
      this.stream = { notice: closed ? 'Live updates stopped; trying again shortly. Showing the last collected data.' : 'Live updates disconnected; reconnecting. Showing the last collected data.' };
      this.refreshStatus();
    };
  }

  apply(data) {
    if (data.session?.name !== this.session) return;
    this.feed = data;
    this.showLive(false);
    if (data.status === 'loading') {
      this.stream = {};
      this.refreshStatus();
      return;
    }
    this.stats = data.stats || this.stats;
    if (Array.isArray(data.processes) && (data.processes.length || data.status === 'ready')) {
      this.processes = data.processes;
    }
    this.drawMachine();
    this.drawUptime();
    this.drawProcesses();
    this.stream = statusText(data);
    this.refreshStatus();
  }

  // --- processes -----------------------------------------------------------------------------------------------------

  drawProcesses() {
    if (!this.stats && !this.processes.length) {
      const reason = waitingReason(this.stats, this.feed);
      if (this.meta) this.meta.textContent = '';
      if (reason) { // say why there is nothing, instead of loading for ever
        if (this.emptyReason !== reason) {
          this.emptyReason = reason;
          this.table.setEmptyState({ icon: 'fa-circle-pause', title: reason });
        }
        this.table.setData([]);
      } else {
        this.table.setLoading(true);
      }
      this.pagination.hidden = true;
      return;
    }
    const filtering = Boolean(this.q.trim());
    const expectedEmpty = filtering ? 'filter' : '';
    if (this.emptyReason !== expectedEmpty) {
      this.emptyReason = expectedEmpty;
      this.table.setEmptyState(filtering
        ? { icon: 'fa-magnifying-glass', title: 'No process matches the filter' }
        : { icon: 'fa-microchip', title: 'No process data available' });
    }
    const view = processPage(this.processes, { sort: this.sort, dir: this.direction, page: this.page, pageSize: PAGE_SIZE, q: this.q });
    this.page = view.page;
    if (this.meta) {
      this.meta.textContent = filtering
        ? `${view.total} of ${this.processes.length} matching`
        : `${this.processes.length} ${this.processes.length === 1 ? 'process' : 'processes'}`;
    }
    this.table.setData(view.items);
    this.pagination.setAttribute('page', String(view.page));
    this.pagination.setAttribute('page-size', String(view.pageSize));
    this.pagination.setAttribute('total-items', String(view.total));
    this.pagination.setAttribute('total-pages', String(view.totalPages));
    this.pagination.hidden = view.total <= view.pageSize;
  }

  columns() {
    return processColumns();
  }
}

customElements.define('colab-tab', ColabTab);

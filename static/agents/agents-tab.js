import '/static/components/table.js';
import '/static/components/pagination.js';
import { tooltip } from '/static/components/tooltip.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { api } from '/static/notes/api.js';
import { copySessionResume } from '/static/agents/session-resume.js';
import { quotaTooltipDetails, shouldRetryQuota } from '/static/agents/quota-donuts.js';
import { SESSION_PAGE_SIZE, bannerText, pagerState, renderOverview, sessionColumns, sessionRows, sessionsKey, sessionsQuery, updatedText } from '/static/agents/usage-render.js';

const REFRESH_MS = 60000; // the server makes a new report every 15 minutes; the page just asks again
const QUOTA_RETRY_MS = 8000; // the first quota run takes a few seconds: ask again soon instead of after a minute
const MESSAGE = 'Hive could not load the usage report.';

/** The Agents tab: this month's usage of Claude, Codex and Antigravity. */
class AgentsTab extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="agents-body">
        <div class="agents-overview"></div>
        <section class="sessions">
          <div class="table-card"><app-table id="sessions-table" sort-mode="server" aria-label="Sessions"></app-table></div>
          <app-pagination id="sessions-pager" hidden></app-pagination>
        </section>
      </div>`;
    this.overview = this.querySelector('.agents-overview');
    this.table = this.querySelector('#sessions-table');
    this.pager = this.querySelector('#sessions-pager');
    // The server sorts and pages the sessions, so the chosen sort and page live here and survive the refresh.
    this.sort = 'last_activity';
    this.direction = 'desc';
    this.page = 0;
    this.sessions = null;
    this.quotaTries = 0; // soon-retries of a quota that is still being collected
    this.quota = null; // optional: without it the cards draw no rings and the usage still shows
    this.view = null;
    this.usageSeq = 0;
    this.sessionsSeq = 0;
    this.quotaSeq = 0;
    this.usageError = '';
    this.sessionsError = '';
    this.table.setColumns(sessionColumns);
    this.table.setDefaultSort(this.sort, this.direction);
    this.table.setEmptyState({ icon: 'fa-comments', title: 'No sessions this month' });
    this.table.setLoading(true);
    this.addEventListener('click', (event) => copySessionResume(event, copyTextToClipboard, showToast));
    this.addEventListener('sort-change', ({ detail }) => {
      this.sort = detail.key;
      this.direction = detail.dir;
      this.page = 0;
      this.loadSessions();
    });
    this.addEventListener('page-change', ({ detail }) => {
      this.page = detail.page;
      this.loadSessions();
    });
    document.addEventListener('visibilitychange', this.onVisible = () => (document.hidden ? this.stop() : this.start()));
    this.draw(null);
    this.start();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisible);
    this.stop();
  }

  // Polls while the tab is shown: an idle tab costs the server nothing.
  start() {
    if (this.timer || document.hidden) return;
    this.load();
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.quotaTimer);
    this.timer = null;
  }

  draw(view) {
    // Only the overview (cards and daily trend) is rendered here; the sessions table stays mounted so quota or report refreshes never lose focus or sort state.
    this.view = view;
    const key = JSON.stringify([view, this.quota]);
    if (key === this.drawn) {
      this.refreshTimes(); // the report is the same, but relative times and quota reset countdowns moved on
      return;
    }
    this.drawn = key;
    this.overview.innerHTML = renderOverview(view, this.quota);
    tooltip.reconcile();
  }

  refreshTimes() {
    const time = this.overview.querySelector('time.updated');
    if (time && this.view?.generated_at) time.textContent = updatedText(this.view.generated_at);
    const stale = this.overview.querySelector('.banner.stale span');
    if (stale && this.view?.status === 'stale') stale.textContent = bannerText(this.view);
    if (this.quota?.providers) {
      const now = new Date();
      for (const donut of this.overview.querySelectorAll('.quota-donut[data-quota-provider]')) {
        const name = donut.getAttribute('data-quota-provider');
        const rows = quotaTooltipDetails(name, this.quota.providers[name], now);
        if (rows.length) donut.dataset.tooltipDetails = JSON.stringify(rows);
      }
    }
  }

  applySessions() {
    const answer = this.sessions;
    const key = sessionsKey(answer);
    if (!this.table || key === this.appliedKey) return;
    this.appliedKey = key;
    if (!answer) {
      this.table.setLoading(true);
      this.pager.hidden = true;
      return;
    }
    this.table.setData(sessionRows(answer.items));
    const state = pagerState(answer);
    this.pager.setAttribute('page-size', String(state.pageSize));
    this.pager.setAttribute('total-items', String(state.totalItems));
    this.pager.setAttribute('total-pages', String(state.totalPages));
    this.pager.setAttribute('page', String(state.page));
    this.pager.hidden = state.hidden;
  }

  fetchSessions() {
    return api(`/agents/usage/sessions?${sessionsQuery({ sort: this.sort, dir: this.direction, page: this.page, pageSize: SESSION_PAGE_SIZE })}`);
  }

  async loadSessions(interactive = true) {
    const seq = ++this.sessionsSeq;
    if (interactive) {
      this.table.setLoading(true);
      this.appliedKey = null;
    }
    try {
      const answer = await this.fetchSessions();
      if (seq !== this.sessionsSeq || !this.isConnected) return;
      this.sessions = answer;
      this.applySessions();
      this.sessionsError = '';
    } catch {
      if (seq !== this.sessionsSeq || !this.isConnected) return;
      if (this.appliedKey) {
        this.sessionsError = 'Could not refresh the sessions; showing the last results.';
      } else {
        this.sessionsError = 'Hive could not load the sessions.';
        this.pager.hidden = true;
        this.table.setError(this.sessionsError);
      }
    }
    this.refreshStatus();
  }

  /** The quota rings. They come from their own request, so a slow CLI never holds the usage back. */
  async loadQuota() {
    const seq = ++this.quotaSeq;
    try {
      const next = await api('/agents/quota');
      if (seq !== this.quotaSeq || !this.isConnected) return;
      this.quota = next;
    } catch {
      // Keep the last good quota rings on a transient fetch failure instead of wiping them.
      if (seq !== this.quotaSeq || !this.isConnected) return;
    }
    if (this.view) this.draw(this.view);
    clearTimeout(this.quotaTimer);
    if (this.timer && shouldRetryQuota(this.quota, this.quotaTries)) {
      this.quotaTries += 1;
      this.quotaTimer = setTimeout(() => this.loadQuota(), QUOTA_RETRY_MS);
    }
  }

  refreshStatus() {
    const text = [this.usageError, this.sessionsError].filter(Boolean).join(' · ');
    const error = Boolean(text);
    this.dispatchEvent(new CustomEvent('tab-status', { bubbles: true, detail: { text, error } }));
  }

  load() {
    this.quotaTries = 0;
    this.loadQuota();
    return Promise.all([this.loadUsage(), this.loadSessions(false)]);
  }

  async loadUsage() {
    const seq = ++this.usageSeq;
    try {
      const view = await api('/agents/usage');
      if (seq !== this.usageSeq || !this.isConnected) return;
      this.loaded = true;
      this.usageError = '';
      this.draw(view);
    } catch {
      if (seq !== this.usageSeq || !this.isConnected) return;
      this.usageError = this.loaded ? 'Could not refresh the usage; showing the last report.' : MESSAGE;
      if (!this.loaded) this.draw({ status: 'unavailable', reason: MESSAGE, providers: {}, month: null, generated_at: null });
    }
    this.refreshStatus();
  }
}

customElements.define('agents-tab', AgentsTab);

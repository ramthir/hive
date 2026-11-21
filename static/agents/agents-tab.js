import '/static/components/table.js';
import '/static/components/pagination.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { api } from '/static/notes/api.js';
import { copySessionResume } from '/static/agents/session-resume.js';
import { shouldRetryQuota } from '/static/agents/quota-donuts.js';
import { SESSION_PAGE_SIZE, pagerState, renderUsage, sessionColumns, sessionRows, sessionsQuery } from '/static/agents/usage-render.js';

const REFRESH_MS = 60000; // the server makes a new report every 15 minutes; the page just asks again
const QUOTA_RETRY_MS = 8000; // the first quota run takes a few seconds: ask again soon instead of after a minute
const MESSAGE = 'Hive could not load the usage report.';

/** The Agents tab: this month's usage of Claude, Codex and Antigravity. */
class AgentsTab extends HTMLElement {
  connectedCallback() {
    this.innerHTML = '<div class="agents-body"></div>';
    this.body = this.querySelector('.agents-body');
    // The server sorts and pages the sessions, so the chosen sort and page live here and survive the refresh.
    this.sort = 'last_activity';
    this.direction = 'desc';
    this.page = 0;
    this.sessions = null;
    this.quotaTries = 0; // soon-retries of a quota that is still being collected
    this.quota = null; // optional: without it the cards draw no rings and the usage still shows
    this.view = null;
    this.seq = 0; // the latest sessions answer wins
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
    // The report changes every 15 minutes: redrawing identical data would reset the table's sort arrow.
    this.view = view;
    const key = JSON.stringify([view, this.quota]);
    if (key === this.drawn) return;
    this.drawn = key;
    this.appliedKey = null;
    this.body.innerHTML = renderUsage(view, this.quota);
    this.table = this.querySelector('#sessions-table');
    this.pager = this.querySelector('#sessions-pager');
    this.table.setColumns(sessionColumns);
    this.table.setDefaultSort(this.sort, this.direction);
    this.table.setEmptyState({ icon: 'fa-comments', title: 'No sessions this month' });
    this.applySessions();
  }

  applySessions() {
    const answer = this.sessions;
    const key = JSON.stringify(answer);
    if (!this.table || key === this.appliedKey) return;
    this.appliedKey = key;
    if (!answer) {
      this.table.setLoading(true);
      this.pager.hidden = true;
      return;
    }
    this.table.setDefaultSort(this.sort, this.direction);
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

  /** A new sort or page: show the table loading, then the answer. */
  async loadSessions() {
    const seq = ++this.seq;
    this.table?.setLoading(true);
    this.appliedKey = null;
    try {
      const answer = await this.fetchSessions();
      if (seq !== this.seq) return;
      this.sessions = answer;
      this.applySessions();
    } catch (error) {
      if (seq === this.seq) this.table?.setError('Hive could not load the sessions.');
    }
  }

  /** The quota rings. They come from their own request, so a slow CLI never holds the usage back. */
  async loadQuota() {
    try {
      this.quota = await api('/agents/quota');
    } catch (error) {
      this.quota = null;
    }
    if (this.view) this.draw(this.view);
    clearTimeout(this.quotaTimer);
    if (this.timer && shouldRetryQuota(this.quota, this.quotaTries)) {
      this.quotaTries += 1;
      this.quotaTimer = setTimeout(() => this.loadQuota(), QUOTA_RETRY_MS);
    }
  }

  say(text, error = false) {
    this.dispatchEvent(new CustomEvent('tab-status', { bubbles: true, detail: { text, error } }));
  }

  async load() {
    this.quotaTries = 0;
    this.loadQuota();
    const seq = ++this.seq;
    try {
      const [view, sessions] = await Promise.all([api('/agents/usage'), this.fetchSessions()]);
      if (seq !== this.seq) return;
      this.sessions = sessions;
      this.loaded = true;
      this.say('');
      this.draw(view);
      this.applySessions();
    } catch (error) {
      if (seq !== this.seq) return;
      if (this.loaded) { // a blip must not wipe a good report: keep it and say so
        this.say('Could not refresh the usage; showing the last report.', true);
        return;
      }
      this.sessions = { items: [], total: 0, page: 0, page_size: SESSION_PAGE_SIZE };
      this.draw({ status: 'unavailable', reason: MESSAGE, providers: {}, month: null, generated_at: null });
    }
  }
}

customElements.define('agents-tab', AgentsTab);

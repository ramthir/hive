import { escapeHtml as esc } from '/static/html.js';
import { api } from '/static/notes/api.js';
import { showToast } from '/static/toast.js';
import { copyStreamUrl } from '/static/iptv/copy.js';
import { openSeriesDrawer } from '/static/iptv/series-drawer.js';
import '/static/components/autocomplete.js';
import { groupSuggestions, insertTerm, starredSuggestions, wantsStarred } from '/static/iptv/search.js';
import {
  TYPES, cardParts, channelsQuery, initials, readState, stateSearch, syncLabel, titleHue,
} from '/static/iptv/format.js';

/* Library (IPTV): browse the provider's catalogue (kept in SQLite on the server) and copy a stream's URL to open in a player such as VLC
   (Media > Open Network Stream). Hive streams nothing. The sidebar's Library group links the three kinds (/library, /library?type=vod,
   /library?type=series). */

class IptvApp extends HTMLElement {
  connectedCallback() {
    this.state = readState(window.location.search);
    this.seq = 0;
    this.innerHTML = `
      <section class="iptv-page">
        <app-header heading="${esc(TYPES.find((t) => t.type === this.state.type).label)}" variant="flush" attached>
          <div slot="actions" class="iptv-header-actions app-header-action-group">
            <app-autocomplete id="iptv-search" class="iptv-search" input-id="iptv-search-input" no-shortcut placeholder="Search ${esc(TYPES.find((t) => t.type === this.state.type).label.toLowerCase())}…" value="${esc(this.state.q)}">
              <div slot="help" class="iptv-search-help">
                <strong class="autocomplete-help-title">Search</strong>
                <p>Type a title, or filter by category with <code>group:</code>. Start typing it to pick a category. Star an item with its ★ and find it again with <code>is:starred</code>.</p>
                <p><code>group:tamil</code> — categories containing "tamil"<br><code>group:"Tamil Movies"</code> — a category with spaces<br><code>raja group:tamil</code> — a title word and a category<br><code>is:starred</code> — only what you starred<br><code>is:starred group:tamil</code> — starred, in a category</p>
              </div>
            </app-autocomplete>
            <button type="button" data-sync title="Load the catalogue from the provider"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Sync</button>
          </div>
        </app-header>
        <div class="iptv-body">
          <p class="iptv-status" role="status" hidden></p>
          <div class="iptv-grid" aria-live="polite"></div>
          <div class="iptv-more" role="status"></div>
        </div>
      </section>`;
    this.grid = this.querySelector('.iptv-grid');
    this.more = this.querySelector('.iptv-more');
    const autocomplete = this.querySelector('#iptv-search');
    const search = autocomplete.input;
    this.groups = [];
    this.loadGroups();
    const suggest = () => { const at = search.selectionStart ?? search.value.length; autocomplete.options = [...starredSuggestions(search.value, at), ...groupSuggestions(this.groups, search.value, at)]; };
    let timer;
    const apply = () => { clearTimeout(timer); this.go({ q: search.value.trim() }); };
    search.addEventListener('input', () => { suggest(); clearTimeout(timer); timer = setTimeout(apply, 250); });
    search.addEventListener('click', suggest);
    search.addEventListener('search', apply);
    autocomplete.addEventListener('select', (event) => {
      event.preventDefault();
      const next = insertTerm(search.value, search.selectionStart ?? search.value.length, event.detail.item?.value ?? event.detail.value);
      autocomplete.value = next.value;
      autocomplete.clearResults();
      search.focus();
      search.setSelectionRange(next.cursor, next.cursor);
      apply();
    });
    this.more.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) this.loadMore(); });
    // Infinite scroll: when the end of the list comes near the window, the next page is fetched.
    this.observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) this.loadMore(); }, { rootMargin: '800px 0px' });
    this.observer.observe(this.more);
    this.querySelector('[data-sync]').addEventListener('click', () => this.sync());
    this.grid.addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) { e.preventDefault(); this.toggleStar(star); return; }
      const series = e.target.closest('[data-series]');
      if (series) { e.preventDefault(); openSeriesDrawer({ id: series.dataset.series, name: series.dataset.name }); return; }
      const copy = e.target.closest('[data-copy]');
      if (copy) { e.preventDefault(); copyStreamUrl(copy); }
    });
    window.addEventListener('popstate', this.onPop = () => { this.state = readState(window.location.search); this.refresh(); });
    this.refresh();
    this.loadStatus();
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this.onPop);
    this.observer?.disconnect();
    clearTimeout(this.statusTimer);
  }

  go(change) {
    this.state = { ...this.state, ...change };
    history.pushState(null, '', `/library${stateSearch(this.state)}`);
    this.refresh();
  }

  /** The categories of this kind, for the `group:` suggestions. */
  async loadGroups() {
    try {
      this.groups = await api(`/iptv/groups?type=${this.state.type}`);
    } catch { /* no suggestions; the search still works */ }
  }

  /** Start the list again (a new kind or search): the first page, then more as the end comes near. */
  async refresh() {
    const box = this.querySelector('.iptv-search');
    if (box.value.trim() !== this.state.q) box.value = this.state.q; // keep what is typed (a trailing space, the caret) while it is the same search
    this.seq += 1;
    this.next = 0; // the next page to fetch
    this.done = false;
    this.loading = false;
    this.grid.innerHTML = '';
    this.more.textContent = '';
    await this.loadMore();
  }

  async loadMore() {
    if (this.loading || this.done) return;
    this.loading = true;
    const seq = this.seq;
    this.more.innerHTML = '<span class="iptv-loading">Loading…</span>';
    try {
      const page = await api(`/iptv/channels?${channelsQuery(this.state, this.next)}`);
      if (seq !== this.seq) return; // the kind or search changed meanwhile: this answer is old
      this.grid.insertAdjacentHTML('beforeend', page.items.map((c) => this.card(c)).join(''));
      this.next += 1;
      this.done = this.next >= page.total_pages;
      this.more.textContent = '';
      if (!page.total) this.grid.innerHTML = '<p class="iptv-empty">Nothing found. Sync the catalogue, or change the search.</p>';
    } catch (error) {
      if (seq !== this.seq) return;
      this.more.innerHTML = `<span class="iptv-loading">${esc(error.message || 'Could not load the catalogue')} <button type="button" data-retry>Try again</button></span>`;
      return; // no automatic retry: it would loop while the provider or server is down
    } finally {
      if (seq === this.seq) this.loading = false;
    }
    // A tall window may still show the end of the list: look again (the observer only reports a change).
    this.observer.unobserve(this.more);
    this.observer.observe(this.more);
  }

  card(c) {
    const { title, quality, subtitle } = cardParts(c);
    const art = `<span class="iptv-art" style="--hue:${titleHue(title)}"><span class="iptv-initials" aria-hidden="true">${esc(initials(title))}</span>${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}${quality ? `<span class="iptv-quality">${esc(quality)}</span>` : ''}</span>`;
    const label = `<span class="iptv-name">${esc(title)}</span><span class="iptv-group-name">${esc(subtitle)}</span>`;
    const cls = `iptv-card iptv-card--${c.type}`;
    const star = `<button type="button" class="iptv-star${c.starred ? ' is-starred' : ''}" data-star data-type="${c.type}" data-id="${esc(c.id)}" aria-pressed="${c.starred ? 'true' : 'false'}" aria-label="Star ${esc(c.name)}" title="${c.starred ? 'Remove the star' : 'Star'}"><i class="${c.starred ? 'fa-solid' : 'fa-regular'} fa-star" aria-hidden="true"></i></button>`;
    // A series has no stream of its own: its card opens a drawer, where each episode has the copy button.
    if (c.type === 'series') {
      return `<div class="${cls}" title="${esc(c.name)}"><button type="button" class="iptv-open" data-series="${esc(c.id)}" data-name="${esc(c.name)}">${art}${label}</button>${star}</div>`;
    }
    return `<div class="${cls}" title="${esc(c.name)}">${art}${label}${star}<button type="button" class="iptv-copy" data-copy data-type="${c.type}" data-id="${esc(c.id)}" aria-label="Copy the stream URL of ${esc(c.name)}" title="Copy stream URL"><i class="fa-regular fa-copy" aria-hidden="true"></i></button></div>`;
  }

  /** Star or unstar a card. The list is not redrawn, so the page keeps its place; a card stays on screen when the search is "is:starred"
   *  (so a misclick can be undone) and is gone the next time the list loads. */
  async toggleStar(button) {
    const { type, id } = button.dataset;
    const starred = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;
    try {
      await api(`/iptv/star?${new URLSearchParams({ type, id })}`, { method: starred ? 'PUT' : 'DELETE' });
      this.paintStar(button, starred);
      if (!starred && wantsStarred(this.state.q)) showToast('Star removed. It leaves this list when you search again.');
    } catch (error) {
      showToast(error.message || 'Could not change the star');
    } finally {
      button.disabled = false;
    }
  }

  paintStar(button, starred) {
    button.setAttribute('aria-pressed', String(starred));
    button.classList.toggle('is-starred', starred);
    button.title = starred ? 'Remove the star' : 'Star';
    const icon = button.querySelector('i');
    if (icon) icon.className = `${starred ? 'fa-solid' : 'fa-regular'} fa-star`;
  }

  async loadStatus() {
    try {
      const status = await api('/iptv/status');
      const line = this.querySelector('.iptv-status');
      line.textContent = syncLabel(status);
      line.hidden = !line.textContent;
      this.querySelector('[data-sync]').disabled = status.running || !status.configured;
      clearTimeout(this.statusTimer);
      if (status.running) this.statusTimer = setTimeout(() => this.loadStatus(), 2000);
      else if (this.wasRunning) { this.wasRunning = false; this.refresh(); }
      this.wasRunning = status.running;
    } catch { /* the status line stays as it was */ }
  }

  async sync() {
    try {
      await api('/iptv/sync', { method: 'POST' });
      this.wasRunning = true;
      this.loadStatus();
    } catch (error) {
      showToast(error.message || 'Could not start the sync');
    }
  }
}

customElements.define('iptv-app', IptvApp);

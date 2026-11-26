import { escapeHtml as esc } from '/static/html.js';
import '/static/components/action-bar.js';
import { api } from '/static/notes/api.js';
import { renderMarkdownPreview } from '/static/notes/markdown.js';
import { CURRENT_USER, initialsOf } from '/static/sidebar.js';
import { applyEvent, finishTurn, historyFor, newTurn, noteKeys, NOTE_SUGGESTIONS, parseSse, quoteIsLong, restoreTurns, selectionChip, selectionToSend, serializeTurns, sessionId, stepIcon, SUGGESTIONS } from '/static/chat/format.js';
import { friendlyLabel, LIVE_STEPS, workSummary } from '/static/chat/steps.js';

/* Chat with the notes. The answers come from Codex (server side) in the notes folder with its own shell. A chat is one Codex session: the
   server tells us its id, we keep it with the turns in this browser and send it back so follow-ups resume it. "New chat" forgets both.

   With a `note` attribute (a slug) it is the chat beside that note (`compact`: a narrow panel): the conversation and its session are that
   note's own, the question says which note it is about, and the host page can set `beforeSend` (an async function that saves what is on
   screen; false stops the send) and `setSelection(text)` (the text selected in the note, sent with the next question). It tells the host
   what happened with `chat-finished` ({slug, changed, renamed}), `chat-navigate` ({href}) and `chat-history` ({slug}) events. */

class ChatApp extends HTMLElement {
  static get observedAttributes() { return ['note']; }

  connectedCallback() {
    if (this.ready) { this.reattach(); return; }
    this.ready = true;
    this.compact = this.hasAttribute('compact');
    this.available = true;
    this.selected = '';
    this.conv = this.loadConv(this.getAttribute('note') || '');
    this.innerHTML = this.compact ? this.compactHtml() : `
      <section class="chat-page">
        <app-header heading="Chat" variant="flush" attached>
          <div slot="actions" class="app-header-action-group">
            <button type="button" id="chat-new" title="Start a new chat"><i class="fa-solid fa-plus"></i><span>New chat</span></button>
          </div>
        </app-header>
        <div class="chat-scroll" id="chat-scroll">
          <div class="chat-notice" id="chat-notice" role="status" hidden></div>
          <div class="chat-column" id="chat-log" aria-live="polite"></div>
        </div>
        <app-action-bar class="chat-action-bar" aria-label="Message">
          <form class="chat-composer" id="chat-form">
            <textarea id="chat-input" rows="1" placeholder="Ask about your notes, or ask me to change one…  (Enter to send, Shift+Enter for a new line)" aria-label="Message"></textarea>
            <button type="submit" class="chat-send" id="chat-send" title="Send" aria-label="Send"><i class="fa-solid fa-arrow-right"></i></button>
          </form>
        </app-action-bar>
      </section>`;
    this.log = this.querySelector('#chat-log');
    this.scroller = this.querySelector('#chat-scroll');
    this.input = this.querySelector('#chat-input');
    this.sendButton = this.querySelector('#chat-send');
    this.querySelector('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); this.submit(); });
    this.querySelector('.chat-action-bar')?.addEventListener('click', () => this.input.focus());
    this.querySelector('#chat-new').addEventListener('click', () => this.reset());
    this.querySelector('#chat-close')?.addEventListener('click', () => this.dispatchEvent(new CustomEvent('chat-close', { bubbles: true })));
    this.querySelector('#chat-clear-selection')?.addEventListener('click', () => { this.setSelection(''); this.input.focus(); });
    this.input.addEventListener('input', () => this.grow());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submit(); }
    });
    this.log.addEventListener('click', (event) => {
      const suggestion = event.target.closest('[data-suggestion]');
      if (suggestion) { this.submit(suggestion.dataset.suggestion); return; }
      const quote = event.target.closest('.chat-user-quote.long');
      if (quote && !String(window.getSelection?.() ?? '')) { quote.classList.toggle('open'); quote.setAttribute('aria-expanded', String(quote.classList.contains('open'))); return; }
      const history = event.target.closest('[data-history]');
      if (history) { this.dispatchEvent(new CustomEvent('chat-history', { bubbles: true, detail: { slug: history.dataset.history } })); return; }
      // Inside a note page a link to a note goes through the page (it asks about unsaved edits and does not reload).
      const link = event.target.closest('a[href^="/notes"]');
      if (link && this.compact && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.button) {
        event.preventDefault();
        this.dispatchEvent(new CustomEvent('chat-navigate', { bubbles: true, detail: { href: link.getAttribute('href') } }));
      }
    });
    this.log.addEventListener('keydown', (event) => {
      const quote = event.target.closest?.('.chat-user-quote.long');
      if (quote && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); quote.click(); }
    });
    this.stick = true;  // follow the newest text until the reader scrolls up
    this.lastTop = 0;
    this.scroller.addEventListener('scroll', () => {
      this.lastTop = this.scroller.scrollTop;
      this.stick = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    });
    this.leaving = false;
    this._persist = () => { this.leaving = true; this.save(this.conv); };
    window.addEventListener('pagehide', this._persist);  // a full navigation away: keep the chat for when we come back
    this.render();
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.updateControls();
    this.checkStatus();
    if (!this.compact) this.input.focus();
  }

  disconnectedCallback() {
    window.removeEventListener('pagehide', this._persist);
    // A host that redraws around us takes the element out and puts it back in the same task: only a real removal stops the run.
    queueMicrotask(() => {
      if (this.isConnected || !this.ready) return;
      this.leaving = true;  // the stream is about to fail because we left: that is a stop, not an error
      this.conv.abort?.abort();
      this.save(this.conv);
    });
  }

  /** Back in the page after the host redrew around us (the stream and the conversation went on meanwhile). */
  reattach() {
    this.leaving = false;
    window.removeEventListener('pagehide', this._persist);
    window.addEventListener('pagehide', this._persist);
    this.scroller.scrollTop = this.stick ? this.scroller.scrollHeight : this.lastTop; // a detached scroller forgets its place
  }

  attributeChangedCallback(name, _old, value) {
    if (!this.ready) return;
    if (name === 'note' && (value || '') !== this.conv.slug) this.switchNote(value || '');
  }

  /* --- Conversations: the page's chat, or one per note. Everything a run touches lives on its own `conv`, so a run that
     outlasts a switch to another note still saves to the note it was asked about. --- */

  loadConv(slug) {
    const keys = noteKeys(slug);
    let turns = [];
    let session = '';
    try { turns = restoreTurns(localStorage.getItem(keys.turns)); } catch (_error) { /* no storage: a fresh chat */ }
    try { session = turns.length ? sessionId(localStorage.getItem(keys.session)) : ''; } catch (_error) { /* as above */ }
    return { slug, keys, turns, session, abort: null };
  }

  /** The conversation lives in this browser only (nothing goes to the server): it survives leaving the page and reloads. */
  save(conv) {
    try {
      if (conv.turns.length) localStorage.setItem(conv.keys.turns, serializeTurns(conv.turns));
      else localStorage.removeItem(conv.keys.turns);
      if (conv.turns.length && conv.session) localStorage.setItem(conv.keys.session, conv.session);
      else localStorage.removeItem(conv.keys.session);
    } catch (_error) { /* storage unavailable: the chat just is not kept */ }
  }

  switchNote(slug) {
    this.conv.abort?.abort();
    this.save(this.conv);
    this.conv = this.loadConv(slug);
    this.selected = '';
    this.stick = true;
    this.render();
    this.renderSelection();
    this.updateControls();
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** The run renamed the note (its heading changed): the conversation and its saved copy follow the new file name. */
  rekey(conv, slug) {
    const old = conv.keys;
    conv.slug = slug;
    conv.keys = noteKeys(slug);
    this.save(conv);
    try { localStorage.removeItem(old.turns); localStorage.removeItem(old.session); } catch (_error) { /* nothing kept */ }
    if (conv === this.conv && this.getAttribute('note') !== slug) this.setAttribute('note', slug);
  }

  get turns() { return this.conv.turns; }
  get running() { return Boolean(this.conv.abort); }

  async checkStatus() {
    try {
      const status = await api('/chat/status');
      this.available = status.available;
      const notice = this.querySelector('#chat-notice');
      notice.hidden = status.available;
      notice.textContent = status.reason || '';
      this.updateControls();
    } catch (_error) { /* the first question reports a real failure */ }
  }

  compactHtml() {
    return `
      <section class="chat-page chat-dock">
        <header class="chat-dock-header">
          <i class="fa-solid fa-comments" aria-hidden="true"></i>
          <span class="chat-dock-title">Chat</span>
          <button type="button" id="chat-new" class="chat-dock-btn" title="Start a new chat about this note" aria-label="New chat"><i class="fa-solid fa-plus"></i></button>
          <button type="button" id="chat-close" class="chat-dock-btn" title="Close the chat" aria-label="Close chat"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="chat-scroll" id="chat-scroll">
          <div class="chat-notice" id="chat-notice" role="status" hidden></div>
          <div class="chat-column" id="chat-log" aria-live="polite"></div>
        </div>
        <div class="chat-dock-foot">
          <div class="chat-context" id="chat-context" hidden><i class="fa-solid fa-quote-left" aria-hidden="true"></i><span id="chat-context-text"></span>
            <button type="button" id="chat-clear-selection" class="chat-dock-btn" title="Do not send the selection" aria-label="Do not send the selection"><i class="fa-solid fa-xmark"></i></button></div>
          <form class="chat-composer chat-composer--dock" id="chat-form">
            <textarea id="chat-input" rows="1" placeholder="Ask about this note, or ask me to change it…" aria-label="Message"></textarea>
            <button type="submit" class="chat-send" id="chat-send" title="Send" aria-label="Send"><i class="fa-solid fa-arrow-right"></i></button>
          </form>
        </div>
      </section>`;
  }

  /** The text selected in the note, to send with the next question (shown as a chip above the box); '' clears it. */
  setSelection(text) {
    this.selected = selectionToSend(text);
    this.renderSelection();
  }

  renderSelection() {
    const box = this.querySelector('#chat-context');
    if (!box) return;
    const chip = selectionChip(this.selected);
    box.hidden = !chip;
    this.querySelector('#chat-context-text').textContent = chip;
    this.querySelector('#chat-context-text').title = this.selected;
  }

  focusInput() { this.input?.focus(); }

  reset() {
    const conv = this.conv;
    conv.abort?.abort();
    conv.turns = [];
    conv.session = '';
    // The server keeps the Codex session too (a note's chat has its own).
    fetch(`/api/chat/session${conv.slug ? `?note=${encodeURIComponent(conv.slug)}` : ''}`, { method: 'DELETE' }).catch(() => {});
    this.save(conv);
    this.render();
    this.input.focus();
  }

  grow() {
    this.input.style.height = '26px';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 180)}px`;
  }

  updateControls() {
    const stop = this.running;
    this.sendButton.classList.toggle('stop', stop);
    this.sendButton.title = this.sendButton.ariaLabel = stop ? 'Stop' : 'Send';
    this.sendButton.innerHTML = `<i class="fa-solid ${stop ? 'fa-stop' : 'fa-arrow-right'}"></i>`;
    this.sendButton.disabled = !stop && !this.available;
  }

  async submit(text) {
    if (this.running) { this.conv.abort.abort(); return; }  // the send button is a stop button while Codex works
    if (this.sending) return;
    const question = (text ?? this.input.value).trim();
    if (!question || !this.available) return;
    if (this.beforeSend) {  // the host saves what is on screen first, so the agent reads the note as it is
      this.sending = true;
      let ok = false;
      try { ok = await this.beforeSend(); } catch (_error) { ok = false; } finally { this.sending = false; }
      if (!ok) return;
    }
    const conv = this.conv;
    const selection = conv.slug ? this.selected : '';
    this.input.value = '';
    this.grow();
    conv.turns.push({ role: 'user', content: question, ...(selection ? { quote: selection } : {}) });
    let turn = { role: 'assistant', ...newTurn(), startedAt: Date.now() };
    conv.turns.push(turn);
    this.save(conv);
    const body = JSON.stringify({
      messages: historyFor(conv.turns.slice(0, -1)),
      ...(conv.session ? { session: conv.session } : {}),
      ...(conv.slug ? { note: conv.slug, ...(selection ? { selection } : {}) } : {}),
    });
    if (selection) this.setSelection('');  // it belongs to this question
    conv.abort = new AbortController();
    this.updateControls();
    this.render();
    this.stick = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    const current = () => conv === this.conv;
    const set = (next) => { turn = Object.assign(turn, next); if (current()) this.renderLast(); };
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: conv.abort.signal });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || `HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === 'session') { conv.session = sessionId(event.id) || conv.session; this.save(conv); }
          if (event.type === 'changed' && event.renamed?.from === conv.slug) this.rekey(conv, event.renamed.slug);
          set(applyEvent(turn, event));
        }
      }
      set(finishTurn(turn));
    } catch (error) {
      set(finishTurn(turn, error.name === 'AbortError' || this.leaving ? { stopped: true } : { failure: error.message }));
    } finally {
      turn.endedAt = Date.now();
      conv.abort = null;
      if (current()) { this.updateControls(); this.renderLast(); if (!this.compact) this.input.focus(); }  // beside a note the reader may be typing in it
      this.save(conv);
      this.dispatchEvent(new CustomEvent('chat-finished', { bubbles: true, detail: { slug: conv.slug, changed: turn.changed, renamed: turn.renamed, status: turn.status } }));
    }
  }

  render() {
    if (!this.turns.length) {
      const suggestions = this.conv.slug ? NOTE_SUGGESTIONS : SUGGESTIONS;
      this.log.innerHTML = this.compact ? `
        <div class="chat-empty">
          <i class="fa-solid fa-comments chat-empty-icon"></i>
          <p>Ask about this note, or ask me to change it. Edits are saved as normal commits, so History can undo them.</p>
          <div class="chat-suggestions">${suggestions.map((s) => `<button type="button" class="chat-suggestion" data-suggestion="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        </div>` : `
        <div class="chat-empty">
          <i class="fa-solid fa-comments chat-empty-icon"></i>
          <h2>Ask your notes</h2>
          <p>Answers come only from your notes, and I can change them too: “add a line to my Home network note”, “mark the Tax task as done”.</p>
          <div class="chat-suggestions">${suggestions.map((s) => `<button type="button" class="chat-suggestion" data-suggestion="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        </div>`;
      return;
    }
    this.log.innerHTML = this.turns.map((turn, i) => this.messageHtml(turn, i)).join('');
    this.afterRender(this.log);
  }

  /** Redraw only the newest message (an event arrived), keeping the scroll at the bottom when it already was. */
  renderLast() {
    const last = this.log.lastElementChild;
    if (!last || !last.classList.contains('assistant')) return;
    last.outerHTML = this.messageHtml(this.turns[this.turns.length - 1], this.turns.length - 1);
    this.afterRender(this.log.lastElementChild);
    if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** The notes a turn changed: links, and for the note this chat is beside a History button to review or undo the change. */
  changedHtml(turn) {
    if (!turn.changed.length) return '';
    const here = this.conv.slug;
    const items = turn.changed.map((n) => (this.compact && n.slug === here
      ? `<button type="button" class="chat-changed-history" data-history="${esc(n.slug)}" title="Open the history of this note to review or undo the change"><i class="fa-solid fa-clock-rotate-left"></i> View changes</button>`
      : `<a href="/notes/${encodeURIComponent(n.slug)}">${esc(n.title)}</a>`));
    return `<div class="chat-changed"><span><i class="fa-solid fa-pen"></i> Changed</span>${items.join('')}</div>`;
  }

  /** The text that was selected in the note when the question was asked, shown above it (a long one folds to a few lines). */
  quoteHtml(quote) {
    if (!quote) return '';
    const long = quoteIsLong(quote);
    return `<blockquote class="chat-user-quote${long ? ' long' : ''}"${long ? ' role="button" tabindex="0" aria-expanded="false" title="Show the whole selection"' : ''}>${esc(quote)}</blockquote>`;
  }

  messageHtml(turn, index) {
    if (turn.role === 'user') {
      return `<div class="chat-message user" data-index="${index}"><div class="chat-avatar" title="${esc(CURRENT_USER.name)}">${esc(initialsOf(CURRENT_USER.name))}</div>
        <div class="chat-body"><div class="chat-sender">Ramesh</div>${this.quoteHtml(turn.quote)}<div class="chat-user-text">${esc(turn.content)}</div></div></div>`;
    }
    const noteItem = (text) => `<li class="narration"><i class="fa-solid fa-comment-dots"></i><span title="${esc(text)}">${esc(text)}</span></li>`;
    const stepItem = (s) => {
      const label = friendlyLabel(s);
      const raw = label !== s.label ? `<code title="${esc(s.label)}">${esc(s.label)}</code>` : '';
      return `<li class="${s.write ? 'write ' : ''}${s.status}"><i class="${stepIcon(s)}"></i><span title="${esc(s.label)}">${esc(label)}</span>${raw}</li>`;
    };
    const running = turn.status === 'running';
    return `<div class="chat-message assistant" data-index="${index}"><div class="chat-avatar"><i class="fa-solid fa-robot"></i></div>
      <div class="chat-body"><div class="chat-sender">Hive</div>
        ${this.workHtml(turn, noteItem, stepItem)}
        ${turn.answer ? `<div class="chat-answer text-flow">${renderMarkdownPreview(turn.answer, { isRoute: (path) => path.startsWith('/notes') })}</div>`
          : running ? '<div class="chat-thinking">Thinking…</div>' : ''}
        ${turn.status === 'error' ? `<div class="chat-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(turn.error)}</div>` : ''}
        ${turn.status === 'stopped' ? '<div class="chat-stopped">Stopped. Anything already saved stays saved (see History on the note).</div>' : ''}
        ${this.changedHtml(turn)}
      </div></div>`;
  }

  /** The work behind an answer. While Codex runs: the newest few steps. Finished: one summary line that opens the whole list
   *  (open by itself when a step failed, so a problem is never hidden). */
  workHtml(turn, noteItem, stepItem) {
    if (turn.status === 'running') {
      const steps = turn.steps.slice(-LIVE_STEPS);
      const earlier = turn.steps.length - steps.length;
      const last = turn.narration.at(-1);
      const items = [...(last ? [noteItem(last)] : []), ...(earlier > 0 ? [`<li class="earlier"><span>+${earlier} earlier</span></li>`] : []), ...steps.map(stepItem)];
      return items.length ? `<ul class="chat-steps">${items.join('')}</ul>` : '';
    }
    const summary = workSummary(turn);
    if (!summary) return '';
    const items = [...turn.narration.map(noteItem), ...turn.steps.map(stepItem)];
    return `<details class="chat-work${summary.failed ? ' failed' : ''}"${summary.open ? ' open' : ''}>
      <summary><i class="fa-solid fa-chevron-right chat-work-chevron"></i><span>${esc(summary.text)}</span>${summary.wrote ? '<i class="fa-solid fa-pen chat-work-wrote" title="Saved changes"></i>' : ''}</summary>
      <ul class="chat-steps">${items.join('')}</ul></details>`;
  }

  /** Link [[wiki links]] in an answer to the notes they name (the same lookup the note page uses). */
  async afterRender(root) {
    const links = [...root.querySelectorAll('.chat-answer .notes-wikilink')];
    const targets = [...new Set(links.map((link) => link.dataset.target).filter(Boolean))];
    if (!targets.length) return;
    let resolved;
    try {
      resolved = await api(`/resolve?${targets.map((t) => `target=${encodeURIComponent(t)}`).join('&')}`);
    } catch (_error) { return; }
    for (const link of links) {
      const hit = resolved[link.dataset.target];
      if (!link.isConnected) continue;
      if (!hit) { link.classList.add('unresolved'); continue; }
      link.setAttribute('href', `/notes/${encodeURIComponent(hit.slug)}`);
      if (link.dataset.autoLabel === 'true') link.textContent = hit.title;
    }
  }
}

customElements.define('chat-app', ChatApp);

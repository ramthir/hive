import { escapeHtml as esc } from '/static/html.js';
import '/static/components/action-bar.js';
import { api } from '/static/notes/api.js';
import { renderMarkdownPreview } from '/static/notes/markdown.js';
import { showToast } from '/static/toast.js';
import { CURRENT_USER, initialsOf } from '/static/sidebar.js';
import { applyEvent, finishTurn, historyFor, newTurn, parseSse, restoreTurns, serializeTurns, sessionId, SESSION_KEY, stepIcon, STORAGE_KEY, SUGGESTIONS } from '/static/chat/format.js';
import { friendlyLabel, LIVE_STEPS, workSummary } from '/static/chat/steps.js';

/* Chat with the notes. The answers come from Codex (server side) in the notes folder with its own shell. A chat is one Codex session: the
   server tells us its id, we keep it with the turns in this browser and send it back so follow-ups resume it. "New chat" forgets both. */

class ChatApp extends HTMLElement {
  connectedCallback() {
    this.turns = this.load();
    this.session = this.loadSession();
    this.abort = null;
    this.available = true;
    this.innerHTML = `
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
    this.querySelector('.chat-action-bar').addEventListener('click', () => this.input.focus());
    this.querySelector('#chat-new').addEventListener('click', () => this.reset());
    this.input.addEventListener('input', () => this.grow());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submit(); }
    });
    this.log.addEventListener('click', (event) => {
      const suggestion = event.target.closest('[data-suggestion]');
      if (suggestion) this.submit(suggestion.dataset.suggestion);
    });
    this.leaving = false;
    this._persist = () => { this.leaving = true; this.save(); };
    window.addEventListener('pagehide', this._persist);  // a full navigation away: keep the chat for when we come back
    this.render();
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.checkStatus();
    this.input.focus();
  }

  disconnectedCallback() {
    this.leaving = true;  // the stream is about to fail because we left: that is a stop, not an error
    window.removeEventListener('pagehide', this._persist);
    this.abort?.abort();
    this.save();
  }

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

  get running() { return Boolean(this.abort); }

  /** The conversation lives in this browser only (nothing goes to the server): it survives leaving the page and reloads. */
  load() {
    try { return restoreTurns(localStorage.getItem(STORAGE_KEY)); } catch (_error) { return []; }
  }

  loadSession() {
    try { return this.turns.length ? sessionId(localStorage.getItem(SESSION_KEY)) : ''; } catch (_error) { return ''; }
  }

  save() {
    try {
      if (this.turns.length) localStorage.setItem(STORAGE_KEY, serializeTurns(this.turns));
      else localStorage.removeItem(STORAGE_KEY);
      if (this.turns.length && this.session) localStorage.setItem(SESSION_KEY, this.session);
      else localStorage.removeItem(SESSION_KEY);
    } catch (_error) { /* storage unavailable: the chat just is not kept */ }
  }

  reset() {
    this.abort?.abort();
    this.turns = [];
    this.session = '';
    fetch('/api/chat/session', { method: 'DELETE' }).catch(() => {}); // the server keeps the Codex session too
    this.save();
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
    if (this.running) { this.abort.abort(); return; }  // the send button is a stop button while Codex works
    const question = (text ?? this.input.value).trim();
    if (!question || !this.available) return;
    this.input.value = '';
    this.grow();
    this.turns.push({ role: 'user', content: question });
    let turn = { role: 'assistant', ...newTurn(), startedAt: Date.now() };
    this.turns.push(turn);
    this.save();
    const body = JSON.stringify({ messages: historyFor(this.turns.slice(0, -1)), ...(this.session ? { session: this.session } : {}) });
    this.abort = new AbortController();
    this.updateControls();
    this.render();
    const set = (next) => { turn = Object.assign(turn, next); this.renderLast(); };
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: this.abort.signal });
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
          if (event.type === 'session') { this.session = sessionId(event.id) || this.session; this.save(); }
          set(applyEvent(turn, event));
        }
      }
      set(finishTurn(turn));
    } catch (error) {
      set(finishTurn(turn, error.name === 'AbortError' || this.leaving ? { stopped: true } : { failure: error.message }));
    } finally {
      turn.endedAt = Date.now();
      this.abort = null;
      this.updateControls();
      this.renderLast();
      this.save();
      this.input.focus();
    }
  }

  render() {
    if (!this.turns.length) {
      this.log.innerHTML = `
        <div class="chat-empty">
          <i class="fa-solid fa-comments chat-empty-icon"></i>
          <h2>Ask your notes</h2>
          <p>Answers come only from your notes, and I can change them too: “add a line to my Home network note”, “mark the Tax task as done”.</p>
          <div class="chat-suggestions">${SUGGESTIONS.map((s) => `<button type="button" class="chat-suggestion" data-suggestion="${esc(s)}">${esc(s)}</button>`).join('')}</div>
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
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    last.outerHTML = this.messageHtml(this.turns[this.turns.length - 1], this.turns.length - 1);
    this.afterRender(this.log.lastElementChild);
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  messageHtml(turn, index) {
    if (turn.role === 'user') {
      return `<div class="chat-message user" data-index="${index}"><div class="chat-avatar" title="${esc(CURRENT_USER.name)}">${esc(initialsOf(CURRENT_USER.name))}</div>
        <div class="chat-body"><div class="chat-sender">Ramesh</div><div class="chat-user-text">${esc(turn.content)}</div></div></div>`;
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
        ${turn.answer ? `<div class="chat-answer notes-preview-pane text-flow">${renderMarkdownPreview(turn.answer, { isRoute: (path) => path.startsWith('/notes') })}</div>`
          : running ? '<div class="chat-thinking">Thinking…</div>' : ''}
        ${turn.status === 'error' ? `<div class="chat-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(turn.error)}</div>` : ''}
        ${turn.status === 'stopped' ? '<div class="chat-stopped">Stopped. Anything already saved stays saved (see History on the note).</div>' : ''}
        ${turn.changed.length ? `<div class="chat-changed"><span><i class="fa-solid fa-pen"></i> Changed</span>${turn.changed.map((n) => `<a href="/notes/${encodeURIComponent(n.slug)}">${esc(n.title)}</a>`).join('')}</div>` : ''}
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

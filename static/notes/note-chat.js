/* The chat beside a note, shared by the note page and the pages of table and timeline notes.

   One `<chat-app compact>` is made the first time the panel opens and then moved into every redraw of its page (a page that redraws takes
   the element out and puts it back in the same task, which does not stop a run that is going on). The panel is a dock beside the note:
   a flex child of the note page's workspace, or (`fixed`) a column fixed to the window's right edge, for pages that scroll with the
   window. While it shows, the host gets the class `chat-docked` and the footer bar stops at the dock's edge (chat.css). Open or closed is
   remembered for every page. */

export const CHAT_OPEN_KEY = 'hive:note-chat-open';

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
export const chatShortcutKey = isMac ? '⌘⇧L' : 'Ctrl+Shift+L';

/** Ctrl/⌘+Shift+L (Ctrl/⌘+Shift+K is taken: the search spotlight answers every Ctrl+K). */
export const isChatShortcut = (event) => (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'l';

/** The footer's chat button. */
export const chatButtonHtml = (open) => `<button id="note-chat-btn" class="tool-button${open ? ' active' : ''}" type="button" title="Chat about this note (${chatShortcutKey})" aria-label="Chat about this note" aria-pressed="${Boolean(open)}"><i class="fa-solid fa-comments" aria-hidden="true"></i></button>`;

export class NoteChatDock {
  /** `host` is the page element. Options: `parent()` the element the dock goes into; `fixed`; `note()` the open note (a `slug` or nothing);
   *  `beforeSend()` an async function that saves what is on screen (false stops the send); `onFinished(detail)` when a run ends
   *  ({slug, changed, renamed, status}); `onNavigate(href)` for a link in an answer; `onHistory()` for "View changes". */
  constructor(host, { parent, fixed = false, note, beforeSend = async () => true, onFinished = () => {}, onNavigate = () => {}, onHistory = () => {} }) {
    this.host = host;
    this.options = { parent, fixed, note, beforeSend, onFinished, onNavigate, onHistory };
    this.chat = null;
    try { this.open = localStorage.getItem(CHAT_OPEN_KEY) === '1'; } catch (_error) { this.open = false; }
  }

  get element() { return this.chat; }

  get running() { return Boolean(this.chat?.running); }

  /** True while a run is going on about this note: a page that would leave it (renamed or deleted) waits for the run to end. */
  holdsNote(slug) { return this.running && this.chat.getAttribute('note') === slug; }

  hasFocus() { return Boolean(this.chat?.contains(document.activeElement)); }

  async ensure() {
    if (this.chat) return this.chat;
    await import('/static/chat/chat-page.js');
    if (this.chat) return this.chat;
    const chat = document.createElement('chat-app');
    chat.setAttribute('compact', '');
    chat.beforeSend = () => this.options.beforeSend();
    chat.addEventListener('chat-close', () => this.setOpen(false));
    chat.addEventListener('chat-finished', (event) => this.options.onFinished(event.detail));
    chat.addEventListener('chat-navigate', (event) => this.options.onNavigate(event.detail.href));
    chat.addEventListener('chat-history', () => this.options.onHistory());
    this.chat = chat;
    return chat;
  }

  /** Put the chat in the page's dock (made here, hidden while closed). Call after every redraw of the page. Only a note that has a file
   *  can be chatted about. */
  mount({ refocus = false } = {}) {
    const slug = this.options.note()?.slug;
    const parent = this.options.parent();
    this.host.classList.remove('chat-docked'); // the footer bar gives the dock its room (CSS) only while the dock shows
    if (!slug || !parent) return;
    if (!this.open && !this.running) return; // closed: nothing to show (a run still going on is kept alive in a hidden dock)
    if (!this.chat) {
      this.ensure().then(() => { if (this.open && this.host.isConnected) this.mount({ refocus: true }); });
      return;
    }
    let dock = parent.querySelector(':scope > .notes-chat-dock');
    if (!dock) {
      dock = document.createElement('aside');
      dock.className = `notes-chat-dock${this.options.fixed ? ' notes-chat-dock--fixed' : ''}`;
      dock.setAttribute('aria-label', 'Chat about this note');
      parent.appendChild(dock);
    }
    dock.hidden = !this.open;
    this.host.classList.toggle('chat-docked', this.open);
    if (this.chat.getAttribute('note') !== slug) this.chat.setAttribute('note', slug);
    if (this.chat.parentElement !== dock) dock.appendChild(this.chat);
    if (refocus && this.open) this.chat.focusInput();
  }

  setOpen(open) {
    this.open = open;
    try { localStorage.setItem(CHAT_OPEN_KEY, open ? '1' : '0'); } catch (_error) { /* not remembered */ }
    const button = this.host.querySelector('#note-chat-btn');
    button?.classList.toggle('active', open);
    button?.setAttribute('aria-pressed', String(open));
    const dock = this.host.querySelector('.notes-chat-dock');
    if (dock) dock.hidden = !open; // the chat stays where it is, so closing the panel does not stop a run
    this.host.classList.toggle('chat-docked', Boolean(dock) && open);
    if (open) this.mount({ refocus: true });
  }

  toggle() { this.setOpen(!this.open); }

  /** The text selected in the note, sent with the next question ('' clears it). */
  setSelection(text) { this.chat?.setSelection(text); }
}

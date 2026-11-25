/* Hive tells open pages when notes change (`GET /api/events`), whether Hive saved them or something else did. */

/** What a page does with a change it heard about, given the revision it holds and the one on the server.
 *  `fresh` is null when the note is gone. Returns 'none' | 'reload' | 'banner' | 'gone'. */
export function remoteAction({ heldRevision, fresh, unsaved }) {
  if (!fresh) return 'gone';
  if (fresh.revision === heldRevision) return 'none'; // our own save, or the same text again
  return unsaved ? 'banner' : 'reload';
}

/** The address to listen on: one note (`{note: slug}`), one type (`{type: 'task'}`) or everything. */
export function eventsUrl({ note, type } = {}) {
  const query = new URLSearchParams();
  if (note) query.set('note', note);
  if (type) query.set('type', type);
  const text = query.toString();
  return `/api/events${text ? `?${text}` : ''}`;
}

/** Calls `onChange(event)` for each change and `onChange({reset: true})` when anything may have changed: the server says so,
 *  or the connection came back (changes made while it was down were not sent). `close()` stops listening.
 *  `source` is only for tests. */
export function watchChanges(filter, onChange, source = null) {
  const url = eventsUrl(filter);
  let stream = null;
  let closed = false;

  const openStream = () => {
    if (closed || stream) return;
    const next = source || new EventSource(url);
    let opened = false;
    next.addEventListener('open', () => {
      if (opened) onChange({ reset: true });
      opened = true;
    });
    next.addEventListener('change', (message) => {
      try { onChange(JSON.parse(message.data)); } catch (_error) { onChange({ reset: true }); }
    });
    stream = next;
  };

  const closeStream = () => {
    if (!stream) return;
    stream.close();
    stream = null;
  };

  // Close SSE connections when the tab is hidden or unloading so background tabs and bfcache never exhaust the browser's
  // per-origin HTTP/1.1 connection pool; reconnect and sync when visible again.
  const win = !source && typeof window !== 'undefined' ? window : null;
  const doc = !source && typeof document !== 'undefined' ? document : null;
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') closeStream();
    else if (!closed) { openStream(); onChange({ reset: true }); }
  };
  const onPageHide = () => closeStream();
  const onPageShow = (event) => {
    if (event.persisted && !closed && (!doc || doc.visibilityState !== 'hidden')) {
      openStream();
      onChange({ reset: true });
    }
  };

  if (doc) doc.addEventListener('visibilitychange', onVisibility);
  if (win) {
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
  }
  if (!doc || doc.visibilityState !== 'hidden') openStream();

  return {
    close: () => {
      closed = true;
      closeStream();
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      if (win) {
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('pageshow', onPageShow);
      }
    },
  };
}

/** Run `fn` once after calls stop coming for `ms`: a burst of events (a git pull, a save and its echo) is one reload. */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

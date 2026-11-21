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
  const stream = source || new EventSource(eventsUrl(filter));
  let opened = false;
  stream.addEventListener('open', () => {
    if (opened) onChange({ reset: true });
    opened = true;
  });
  stream.addEventListener('change', (message) => {
    try { onChange(JSON.parse(message.data)); } catch (_error) { onChange({ reset: true }); }
  });
  return { close: () => stream.close() };
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

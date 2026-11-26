/* Chat logic without DOM: reading the server's event stream, folding events into a turn, and the messages sent back. */

/** Split a server-sent-events buffer into parsed `data:` events; `rest` is the unfinished tail to carry into the next chunk. */
export function parseSse(buffer) {
  const events = [];
  const parts = String(buffer).split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const data = part.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch (_error) { /* not ours: skip */ }
  }
  return { events, rest };
}

export const newTurn = () => ({ steps: [], narration: [], answer: '', changed: [], renamed: null, status: 'running', error: '', startedAt: 0, endedAt: 0 });

/** The turn after one event (a new object). `message` events are Codex's text: the newest is the answer and the one it
 *  replaces becomes a line of narration ("Let me look that up."), since only the last message answers. */
export function applyEvent(turn, event) {
  switch (event?.type) {
    case 'step': {
      const step = { id: event.id, tool: event.tool, label: event.label, write: Boolean(event.write), status: event.status };
      const at = turn.steps.findIndex((s) => s.id === step.id);
      const steps = at < 0 ? [...turn.steps, step] : turn.steps.map((s, i) => (i === at ? { ...s, ...step } : s));
      return { ...turn, steps };
    }
    case 'message':
      return { ...turn, narration: turn.answer ? [...turn.narration, turn.answer] : turn.narration, answer: event.text };
    case 'changed':
      return { ...turn, changed: event.notes || [], renamed: event.renamed?.slug ? event.renamed : null };
    case 'done':
      return { ...turn, status: turn.status === 'error' ? 'error' : 'done' };
    case 'error':
      return { ...turn, status: 'error', error: event.message || 'Something went wrong.' };
    default:
      return turn;
  }
}

/** A turn that ends without `done` or `error` (the stream was cut, or the user stopped it). */
export function finishTurn(turn, { stopped = false, failure = '' } = {}) {
  if (turn.status !== 'running') return turn;
  if (stopped) return { ...turn, status: 'stopped' };
  return { ...turn, status: 'error', error: failure || 'The connection closed before Codex finished.' };
}

/** The messages the server needs: only what was said, never the steps. A turn that failed or was stopped without an
 *  answer is left out so the model is not shown an empty reply. */
export function historyFor(turns) {
  const out = [];
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: turn.content });
    else if (turn.answer) out.push({ role: 'assistant', content: turn.answer });
  }
  return out;
}

export const stepIcon = (step) => (step.status === 'running' ? 'fa-solid fa-circle-notch fa-spin'
  : step.status === 'failed' ? 'fa-solid fa-triangle-exclamation' : step.write ? 'fa-solid fa-pen' : 'fa-solid fa-check');

export const SUGGESTIONS = Object.freeze([
  'What are my open tasks, most urgent first?',
  'What did I work on this week?',
  'Summarise my most recently edited note.',
]);

export const STORAGE_KEY = 'hive:chat';
export const SESSION_KEY = 'hive:chat-session';

/** The browser-storage keys of a conversation: the chat page's, or (with a slug) the chat beside that note, one per note. */
export const noteKeys = (slug) => (slug ? { turns: `${STORAGE_KEY}:note:${slug}`, session: `${SESSION_KEY}:note:${slug}` } : { turns: STORAGE_KEY, session: SESSION_KEY });

export const NOTE_SUGGESTIONS = Object.freeze([
  'Summarise this note.',
  'Fix spelling and grammar.',
  'Tidy the structure and headings.',
]);

export const MAX_SELECTION = 4000;

/** What the chat shows for the text selected in the note: one line, cut, or '' for nothing worth sending. */
export function selectionChip(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** The selection as it is sent: trimmed and cut to what the server accepts. */
export const selectionToSend = (text) => String(text ?? '').trim().slice(0, MAX_SELECTION);

/** Whether a quoted selection in the history is long enough to be folded to a few lines (a click shows it all). */
export const quoteIsLong = (text) => String(text ?? '').length > 240 || String(text ?? '').split('\n').length > 3;

/** A Codex session id as the server sent it (a UUID), or '' for anything else: it is sent back with the next question. */
export const sessionId = (value) => (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value ?? '')) ? String(value) : '');
const MAX_SAVED_TURNS = 40;

/** The conversation as text for the browser's storage: the last turns, nothing else. */
export function serializeTurns(turns) {
  return JSON.stringify(turns.slice(-MAX_SAVED_TURNS));
}

/** The turns saved by `serializeTurns`, checked (a stale or hand-edited value gives []). A turn that was still running when the
 *  page closed has no one left to finish it: it comes back as stopped, with the answer it had. */
export function restoreTurns(raw) {
  let saved;
  try { saved = JSON.parse(raw); } catch (_error) { return []; }
  if (!Array.isArray(saved)) return [];
  const turns = [];
  for (const turn of saved) {
    if (turn?.role === 'user' && typeof turn.content === 'string') {
      const quote = typeof turn.quote === 'string' ? selectionToSend(turn.quote) : '';
      turns.push({ role: 'user', content: turn.content, ...(quote ? { quote } : {}) });
    }
    else if (turn?.role === 'assistant') {
      const base = newTurn();
      const status = ['done', 'error', 'stopped'].includes(turn.status) ? turn.status : 'stopped';
      turns.push({ role: 'assistant', ...base, status, error: String(turn.error || ''), answer: String(turn.answer || ''),
        narration: Array.isArray(turn.narration) ? turn.narration.map(String) : [],
        steps: Array.isArray(turn.steps) ? turn.steps.filter((s) => s && typeof s.label === 'string').map((s) => ({ ...s, status: s.status === 'running' ? 'failed' : s.status })) : [],
        startedAt: Number(turn.startedAt) || 0, endedAt: Number(turn.endedAt) || 0,
        changed: Array.isArray(turn.changed) ? turn.changed.filter((n) => n && typeof n.slug === 'string') : [] });
    }
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();  // a conversation starts with a question
  return turns;
}

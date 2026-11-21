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

export const newTurn = () => ({ steps: [], narration: [], answer: '', changed: [], status: 'running', error: '' });

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
      return { ...turn, changed: event.notes || [] };
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

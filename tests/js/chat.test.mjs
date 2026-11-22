import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyLabel, workSummary, words, LIVE_STEPS } from '../../static/chat/steps.js';
import { applyEvent, finishTurn, historyFor, newTurn, parseSse, restoreTurns, serializeTurns, sessionId, stepIcon } from '../../static/chat/format.js';

test('parseSse returns whole events and keeps the unfinished tail', () => {
  const first = parseSse('data: {"type":"step","id":"1"}\n\ndata: {"type":"mess');
  assert.deepEqual(first.events, [{ type: 'step', id: '1' }]);
  const second = parseSse(first.rest + 'age","text":"hi"}\n\n');
  assert.deepEqual(second.events, [{ type: 'message', text: 'hi' }]);
  assert.equal(second.rest, '');
});

test('parseSse skips comments, junk and CRLF framing', () => {
  const { events } = parseSse(': ping\n\ndata: nope\n\ndata: {"type":"done"}\r\n\r\n');
  assert.deepEqual(events, [{ type: 'done' }]);
});

test('a step is added once and then updated in place', () => {
  let turn = applyEvent(newTurn(), { type: 'step', id: 'a', tool: 'read_note', label: 'Reading x', write: false, status: 'running' });
  turn = applyEvent(turn, { type: 'step', id: 'b', tool: 'edit_note', label: 'Editing x', write: true, status: 'running' });
  turn = applyEvent(turn, { type: 'step', id: 'a', tool: 'read_note', label: 'Reading x', write: false, status: 'done' });
  assert.deepEqual(turn.steps.map((s) => [s.id, s.status]), [['a', 'done'], ['b', 'running']]);
});

test('the newest message is the answer and the one it replaces becomes narration', () => {
  let turn = applyEvent(newTurn(), { type: 'message', text: 'Let me look.' });
  assert.equal(turn.answer, 'Let me look.');
  assert.deepEqual(turn.narration, []);
  turn = applyEvent(turn, { type: 'message', text: 'It says first.' });
  assert.equal(turn.answer, 'It says first.');
  assert.deepEqual(turn.narration, ['Let me look.']);
});

test('events do not change the turn they were applied to', () => {
  const turn = newTurn();
  applyEvent(turn, { type: 'message', text: 'x' });
  applyEvent(turn, { type: 'step', id: '1', status: 'running' });
  assert.deepEqual(turn, newTurn());
});

test('done, error and changed', () => {
  assert.equal(applyEvent(newTurn(), { type: 'done' }).status, 'done');
  const failed = applyEvent(newTurn(), { type: 'error', message: 'no auth' });
  assert.deepEqual([failed.status, failed.error], ['error', 'no auth']);
  assert.equal(applyEvent(failed, { type: 'done' }).status, 'error');
  assert.deepEqual(applyEvent(newTurn(), { type: 'changed', notes: [{ slug: 'a', title: 'A' }] }).changed, [{ slug: 'a', title: 'A' }]);
  assert.equal(applyEvent(newTurn(), { type: 'unknown' }).status, 'running');
});

test('a turn cut off is stopped by the user or an error, and a finished one is left alone', () => {
  assert.equal(finishTurn(newTurn(), { stopped: true }).status, 'stopped');
  const cut = finishTurn(newTurn());
  assert.equal(cut.status, 'error');
  assert.match(cut.error, /closed/);
  assert.equal(finishTurn(cut, { stopped: true }).status, 'error');
  assert.equal(finishTurn({ ...newTurn(), status: 'done' }).status, 'done');
});

test('history keeps what was said and drops steps and empty answers', () => {
  const turns = [
    { role: 'user', content: 'q1' }, { role: 'assistant', ...newTurn(), answer: 'a1', steps: [{ id: '1' }] },
    { role: 'user', content: 'q2' }, { role: 'assistant', ...newTurn(), status: 'error', error: 'x' },
    { role: 'user', content: 'q3' },
  ];
  assert.deepEqual(historyFor(turns), [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }]);
});

test('step icons', () => {
  assert.match(stepIcon({ status: 'running' }), /spin/);
  assert.match(stepIcon({ status: 'failed' }), /triangle/);
  assert.match(stepIcon({ status: 'done', write: true }), /pen/);
  assert.match(stepIcon({ status: 'done', write: false }), /check/);
});


test('a saved conversation comes back as it was', () => {
  const turns = [{ role: 'user', content: 'q' }, { role: 'assistant', ...newTurn(), status: 'done', answer: 'a', narration: ['hm'],
    steps: [{ id: '1', tool: 'edit_note', label: 'Editing x', write: true, status: 'done' }], changed: [{ slug: 'x', title: 'X' }] }];
  assert.deepEqual(restoreTurns(serializeTurns(turns)), turns);
});

test('a turn that was running when the page closed comes back stopped, with its unfinished steps failed', () => {
  const running = [{ role: 'user', content: 'q' }, { role: 'assistant', ...newTurn(), answer: 'so far', steps: [{ id: '1', label: 'Reading x', status: 'running' }] }];
  const [, turn] = restoreTurns(serializeTurns(running));
  assert.equal(turn.status, 'stopped');
  assert.equal(turn.answer, 'so far');
  assert.equal(turn.steps[0].status, 'failed');
});

test('only the last turns are kept and the conversation starts with a question', () => {
  const many = Array.from({ length: 60 }, (_, i) => (i % 2 ? { role: 'assistant', ...newTurn(), status: 'done', answer: `a${i}` } : { role: 'user', content: `q${i}` }));
  const back = restoreTurns(serializeTurns(many));
  assert.equal(back.length, 40);
  assert.equal(back[0].role, 'user');
  assert.deepEqual(restoreTurns(serializeTurns([{ role: 'assistant', ...newTurn(), status: 'done', answer: 'orphan' }])), []);
});

test('rubbish in storage gives an empty chat', () => {
  for (const raw of [null, '', 'nope', '{}', '[1,"x",null,{"role":"system"}]']) assert.deepEqual(restoreTurns(raw), []);
});

test('only a UUID is kept as the Codex session, and the turn ignores the event', () => {
  assert.equal(sessionId('01a1fe57-662c-77f0-bf0c-d522d9b8d05b'), '01a1fe57-662c-77f0-bf0c-d522d9b8d05b');
  for (const bad of ['', null, undefined, '--last', 'abc', '01a1fe57-662c-77f0-bf0c-d522d9b8d05b --x']) assert.equal(sessionId(bad), '');
  const turn = newTurn();
  assert.equal(applyEvent(turn, { type: 'session', id: '01a1fe57-662c-77f0-bf0c-d522d9b8d05b' }), turn);
});


const step = (label, extra = {}) => ({ id: label, tool: 'shell', label, write: false, status: 'done', ...extra });

test('words honours quotes and keeps a quoted pattern as one word', () => {
  assert.deepEqual(words(`rg -n 'a b' "c d" e`), ['rg', '-n', 'a b', 'c d', 'e']);
  assert.deepEqual(words(''), []);
});

test('commands get a readable label and anything unknown keeps its command', () => {
  assert.equal(friendlyLabel(step("rg -il --glob '*.md' --glob '!AGENTS.md' '\\bendowus\\b' | head -100")), 'Searched notes for “endowus”');
  assert.equal(friendlyLabel(step('rg --files | rg -i endowus')), 'Listed notes');
  assert.equal(friendlyLabel(step('cat endowus.md endowus-invest.md')), 'Read endowus.md and 1 more');
  assert.equal(friendlyLabel(step("sed -n '45,86p' limark-project-allocation.md")), 'Read limark-project-allocation.md');
  assert.equal(friendlyLabel(step("sed -i 's/a/b/' home.md")), 'Edited home.md');
  assert.equal(friendlyLabel(step('git add -- x.md && git commit -m "doc: add storage" -- x.md', { write: true })), 'Committed: doc: add storage');
  assert.equal(friendlyLabel(step('git mv a.md b.md')), 'Renamed a.md to b.md');
  assert.equal(friendlyLabel(step('git status --short')), 'Checked what changed');
  assert.equal(friendlyLabel(step('ls -la')), 'Listed files');
  assert.equal(friendlyLabel(step('if [ -f AGENTS.md ]; then cat AGENTS.md; fi')), 'Read AGENTS.md');
  assert.equal(friendlyLabel(step('python3 weird.py')), 'python3 weird.py');
  assert.equal(friendlyLabel({ tool: 'file_change', label: 'Editing a.md, b.md' }), 'Edited a.md, b.md');
});

test('the summary is one line for a finished turn and nothing while it runs or when it did no work', () => {
  const done = { ...newTurn(), status: 'done', startedAt: 1000, endedAt: 15400, answer: 'x', steps: [step('cat a.md'), step('git commit -m x', { write: true })], changed: [{ slug: 'a', title: 'A' }] };
  assert.deepEqual(workSummary(done), { text: 'Worked for 14s · 2 steps · changed 1 note', wrote: true, failed: 0, open: false });
  assert.equal(workSummary({ ...done, status: 'running' }), null);
  assert.equal(workSummary({ ...newTurn(), status: 'done', answer: 'hi' }), null);
  assert.equal(workSummary({ ...done, startedAt: 0, changed: [], steps: [step('cat a.md')] }).text, 'Worked · 1 step');
  assert.equal(workSummary({ ...done, startedAt: 0, endedAt: 0, steps: [step('sed -i x a.md', { write: true })], changed: [] }).text, 'Worked · 1 step · edited files');
  assert.equal(workSummary({ ...done, startedAt: 0, endedAt: 125000 + 0, changed: [], steps: [step('cat a')] }).text, 'Worked · 1 step');
});

test('a failed step or an error opens the work by itself and long runs read as minutes', () => {
  const failed = { ...newTurn(), status: 'done', startedAt: 0, endedAt: 0, steps: [step('cat a'), step('cat b', { status: 'failed' })] };
  assert.deepEqual([workSummary(failed).open, workSummary(failed).failed, workSummary(failed).text], [true, 1, 'Worked · 2 steps · 1 failed']);
  assert.equal(workSummary({ ...newTurn(), status: 'error', steps: [step('cat a')] }).open, true);
  assert.match(workSummary({ ...newTurn(), status: 'done', startedAt: 1000, endedAt: 126000, steps: [step('cat a')] }).text, /^Worked for 2m 5s/);
  assert.ok(LIVE_STEPS >= 3);
});

test('start and end times survive saving the conversation', () => {
  const saved = serializeTurns([{ role: 'user', content: 'q' }, { role: 'assistant', ...newTurn(), status: 'done', startedAt: 5, endedAt: 9, answer: 'a' }]);
  const [, turn] = restoreTurns(saved);
  assert.deepEqual([turn.startedAt, turn.endedAt], [5, 9]);
  assert.deepEqual([restoreTurns('[{"role":"user","content":"q"},{"role":"assistant","startedAt":"x"}]')[1].startedAt], [0]);
});

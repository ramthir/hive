import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, finishTurn, historyFor, newTurn, parseSse, stepIcon } from '../../static/chat/format.js';

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

import { restoreTurns, serializeTurns } from '../../static/chat/format.js';

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

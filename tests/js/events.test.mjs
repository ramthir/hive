import test from 'node:test';
import assert from 'node:assert/strict';

const { debounce, eventsUrl, remoteAction, watchChanges } = await import('../../static/events.js');

test('the address names the note or type to listen to', () => {
  assert.equal(eventsUrl({ note: 'my-note' }), '/api/events?note=my-note');
  assert.equal(eventsUrl({ type: 'task' }), '/api/events?type=task');
  assert.equal(eventsUrl({ note: 'a b' }), '/api/events?note=a+b');
  assert.equal(eventsUrl(), '/api/events');
});

test('a page ignores its own save, reloads a clean note and asks about one with unsaved edits', () => {
  assert.equal(remoteAction({ heldRevision: 'r1', fresh: { revision: 'r1' }, unsaved: true }), 'none');
  assert.equal(remoteAction({ heldRevision: 'r1', fresh: { revision: 'r2' }, unsaved: false }), 'reload');
  assert.equal(remoteAction({ heldRevision: 'r1', fresh: { revision: 'r2' }, unsaved: true }), 'banner');
  assert.equal(remoteAction({ heldRevision: 'r1', fresh: null, unsaved: false }), 'gone');
});

class FakeSource {
  constructor() { this.handlers = {}; this.closed = false; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  close() { this.closed = true; }
}

test('changes are passed on, a bad payload and a reconnect mean look again, and close stops listening', () => {
  const source = new FakeSource();
  const heard = [];
  const watch = watchChanges({ note: 'a' }, (event) => heard.push(event), source);
  source.handlers.open();
  assert.deepEqual(heard, []); // the first connection is not news
  source.handlers.change({ data: '{"slug":"a","revision":"r2"}' });
  source.handlers.change({ data: 'not json' });
  source.handlers.open(); // it came back after a drop
  assert.deepEqual(heard, [{ slug: 'a', revision: 'r2' }, { reset: true }, { reset: true }]);
  watch.close();
  assert.equal(source.closed, true);
});

test('watchChanges closes on pagehide/hidden and reconnects with reset on visible/pageshow', () => {
  const docHandlers = {};
  const winHandlers = {};
  const created = [];
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  const origES = globalThis.EventSource;
  try {
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: (name, fn) => { docHandlers[name] = fn; },
      removeEventListener: (name, fn) => { if (docHandlers[name] === fn) delete docHandlers[name]; },
    };
    globalThis.window = {
      addEventListener: (name, fn) => { winHandlers[name] = fn; },
      removeEventListener: (name, fn) => { if (winHandlers[name] === fn) delete winHandlers[name]; },
    };
    globalThis.EventSource = class extends FakeSource {
      constructor(url) { super(); this.url = url; created.push(this); }
    };
    const heard = [];
    const watch = watchChanges({ note: 'a' }, (event) => heard.push(event));
    assert.equal(created.length, 1);

    globalThis.document.visibilityState = 'hidden';
    docHandlers.visibilitychange();
    assert.equal(created[0].closed, true);

    globalThis.document.visibilityState = 'visible';
    docHandlers.visibilitychange();
    assert.equal(created.length, 2);
    assert.deepEqual(heard, [{ reset: true }]);

    winHandlers.pagehide();
    assert.equal(created[1].closed, true);

    winHandlers.pageshow({ persisted: true });
    assert.equal(created.length, 3);
    assert.deepEqual(heard, [{ reset: true }, { reset: true }]);

    watch.close();
    assert.equal(created[2].closed, true);
    assert.equal(docHandlers.visibilitychange, undefined);
    assert.equal(winHandlers.pagehide, undefined);
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
    globalThis.EventSource = origES;
  }
});

test('a burst of calls runs once, and cancel drops it', async () => {
  let runs = 0;
  const run = debounce(() => { runs += 1; }, 10);
  run(); run(); run();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 1);
  run(); run.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 1);
});

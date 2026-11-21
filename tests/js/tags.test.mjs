import test from 'node:test';
import assert from 'node:assert/strict';
import { tagOptions } from '../../static/notes/tags.js';

test('tag options are sorted by name ignoring case, with the number of notes', () => {
  const options = tagOptions({ zeta: 2, Apigee: 15, apple: 1 });
  assert.deepEqual(options.map((o) => o.value), ['Apigee', 'apple', 'zeta']);
  assert.deepEqual(options[0], { value: 'Apigee', label: 'Apigee', meta: '15' });
});

test('the casing variants of a tag are both offered', () => {
  assert.deepEqual(tagOptions({ Todo: 3, todo: 30 }).map((o) => o.value), ['todo', 'Todo']);
});

test("a note's own new tag is offered without a count", () => {
  const options = tagOptions({ a: 1 }, ['fresh', 'a', ' ']);
  assert.deepEqual(options.map((o) => o.value), ['a', 'fresh']);
  assert.equal('meta' in options.find((o) => o.value === 'fresh'), false);
});

test('no tags known is fine', () => {
  assert.deepEqual(tagOptions(), []);
});

import { tagChips } from '../../static/notes/tags.js';

test('read mode shows each tag as a button that carries the tag, escaped', () => {
  const html = tagChips(['one', 'a "b" <c>']);
  assert.match(html, /data-tag="one"[^>]*>#one</);
  assert.match(html, /data-tag="a &quot;b&quot; &lt;c&gt;"/);
  assert.equal(tagChips([]), '');
});

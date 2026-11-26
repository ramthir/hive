import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../../static/html.js';

const STATIC = fileURLToPath(new URL('../../static/', import.meta.url));

function* scripts(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(path).isDirectory()) yield* scripts(path);
    else if (name.endsWith('.js')) yield path;
  }
}

test('escapeHtml escapes text for content and quoted attributes', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(3), '3');
});

test('html.js is the only HTML escaper: every page and component imports it', () => {
  const own = [...scripts(STATIC)]
    .filter((path) => !path.endsWith(`${join('static', 'html.js')}`))
    .filter((path) => /&amp;/.test(readFileSync(path, 'utf8')) && /\[&<>/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(own.map((path) => path.slice(STATIC.length)), []);
});

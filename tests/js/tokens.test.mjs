import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = fileURLToPath(new URL('../../static/', import.meta.url));
// The editor's syntax theme and the PlantUML highlighter define their own colours on purpose.
const OWN_PALETTE = new Set(['tokens.css', join('components', 'editor.js'), join('notes', 'plantuml-lang.js')]);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(css|js)$/.test(name)) yield path;
  }
}

const palette = readFileSync(join(STATIC, 'tokens.css'), 'utf8').match(/#[0-9a-f]{6}\b/gi).map((hex) => hex.toLowerCase());

test('palette colours come from tokens.css, never as a hex copy or a dead var() fallback', () => {
  const found = [];
  for (const path of sources(STATIC)) {
    const file = path.slice(STATIC.length);
    if (OWN_PALETTE.has(file)) continue;
    for (const hex of readFileSync(path, 'utf8').match(/#[0-9a-f]{6}\b/gi) || []) {
      if (palette.includes(hex.toLowerCase())) found.push(`${file}: ${hex}`);
    }
  }
  assert.deepEqual(found, []);
});

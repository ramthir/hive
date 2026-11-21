import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPE_ICONS, TYPE_COLORS, FALLBACK_ICON, DEFAULT_TYPE, typeIcon, noteTypeIcon, typeColor, noteTypeColor } from '../../static/type-icons.js';

// Every type used in the notes vault (`type:` frontmatter) must have its own, deliberate icon.
const VAULT_TYPES = ['note', 'contact', 'task', 'clipping', 'project', 'holiday', 'prompt', 'spec', 'product',
  'meeting', 'timeline', 'glossary', 'company', 'book', 'reference', 'keynote', 'hub', 'guideline', 'interview'];

test('every type used in the vault has an icon of its own, not the fallback', () => {
  for (const type of VAULT_TYPES) {
    assert.ok(TYPE_ICONS[type], `no icon for "${type}"`);
    assert.notEqual(TYPE_ICONS[type], FALLBACK_ICON, `"${type}" would look like an unknown type`);
  }
});

test('every icon name exists in the vendored Font Awesome, so none renders as a blank square', () => {
  const css = readFileSync(new URL('../../static/vendor/fontawesome/css/all.min.css', import.meta.url), 'utf8');
  for (const icon of new Set([...Object.values(TYPE_ICONS), FALLBACK_ICON])) {
    assert.ok(css.includes(`.fa-${icon}:before`), `fa-${icon} is not in all.min.css`);
  }
});

test('type names are matched ignoring case, spaces, dashes and underscores', () => {
  assert.equal(typeIcon('Task'), TYPE_ICONS.task);
  assert.equal(typeIcon('  CONTACT '), TYPE_ICONS.contact);
  assert.equal(typeIcon('Meeting Minutes'), TYPE_ICONS.meeting_minutes);
  assert.equal(typeIcon('meeting-minutes'), TYPE_ICONS.meeting_minutes);
  assert.equal(typeIcon('work nature'), TYPE_ICONS.work_nature);
});

test('an unknown or empty type gets the plain file icon', () => {
  for (const type of ['zzz', '', null, undefined, 42]) assert.equal(typeIcon(type), FALLBACK_ICON);
});

test('a note takes the icon of its first type, or of the default type when it has none', () => {
  assert.equal(noteTypeIcon(['task', 'contact']), TYPE_ICONS.task);
  assert.equal(noteTypeIcon(['', 'contact']), TYPE_ICONS.contact); // blanks are skipped
  assert.equal(noteTypeIcon([]), TYPE_ICONS[DEFAULT_TYPE]);
  assert.equal(noteTypeIcon(undefined), TYPE_ICONS[DEFAULT_TYPE]);
  assert.equal(noteTypeIcon(['mystery']), FALLBACK_ICON);
});

import { typeLabel, typeOptions } from '../../static/type-icons.js';

test('type options are the known, vault and current types by name, each with an icon', () => {
  const options = typeOptions(['timeline', 'zzz'], ['task', 'custom']);
  const names = options.map((o) => o.value);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(new Set(names).size, names.length);
  for (const type of ['task', 'note', 'timeline', 'zzz', 'custom']) assert.ok(names.includes(type), type);
  assert.deepEqual(options.find((o) => o.value === 'task'), { value: 'task', label: 'Task', icon: 'fa-solid fa-list-check' });
  assert.match(options.find((o) => o.value === 'custom').icon, /^fa-solid fa-/);
});

test('type options work with nothing to add', () => {
  assert.ok(typeOptions().length > 10);
});

test('a type is shown in title case while its value is kept', () => {
  assert.equal(typeLabel('meeting_minutes'), 'Meeting Minutes');
  assert.equal(typeLabel('work-nature'), 'Work Nature');
  assert.equal(typeLabel(' task '), 'Task');
  const option = typeOptions([], ['meeting_minutes']).find((o) => o.value === 'meeting_minutes');
  assert.equal(option.label, 'Meeting Minutes');
});

test('every icon colour names a palette colour, and every coloured type has an icon', () => {
  const tokens = readFileSync(new URL('../../static/tokens.css', import.meta.url), 'utf8');
  for (const [type, color] of Object.entries(TYPE_COLORS)) {
    assert.ok(tokens.includes(`--color-${color}:`), `--color-${color} (for "${type}") is not in tokens.css`);
    assert.ok(TYPE_ICONS[type], `"${type}" has a colour but no icon`);
  }
});

test('every type used in the vault has a colour', () => {
  for (const type of VAULT_TYPES) assert.ok(TYPE_COLORS[type], `no colour for "${type}"`);
});

test('a note takes the colour of its first type like its icon; an unknown type has none', () => {
  assert.equal(typeColor('Task'), 'var(--color-orange)');
  assert.equal(typeColor('Meeting'), 'var(--color-blue)');
  assert.equal(typeColor('Meeting Minutes'), 'var(--color-yellow)');
  assert.equal(typeColor('zzz'), '');
  assert.equal(noteTypeColor(['', 'contact']), 'var(--color-green)');
  assert.equal(noteTypeColor([]), typeColor(DEFAULT_TYPE));
  assert.equal(noteTypeColor(['zzz']), '');
});

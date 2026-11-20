import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TYPE_ICONS, FALLBACK_ICON, DEFAULT_TYPE, typeIcon, noteTypeIcon } from '../../static/type-icons.js';

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

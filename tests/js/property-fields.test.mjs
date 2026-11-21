import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisible, missingRequired, propertyChanges } from '../../static/notes/property-fields.js';

const field = (key, extra = {}) => ({ key, label: key, icon: 'tag', kind: 'text', target: 'property', value: '', choices: [], ...extra });

test('only changed fields are sent, and plain fields go under properties', () => {
  const fields = [field('project', { value: 'Acme' }), field('assignee', { value: 'Bo' })];
  assert.deepEqual(propertyChanges(fields, { project: 'Acme', assignee: 'Al' }), { properties: { assignee: 'Al' } });
});

test('nothing changed means nothing to send', () => {
  assert.equal(propertyChanges([field('project', { value: 'Acme' })], { project: ' Acme ' }), null);
});

test('status, priority and week are top-level keys of the update', () => {
  const fields = [field('status', { target: 'status', value: 'TODO' }), field('priority', { target: 'priority', value: '' }),
    field('week', { target: 'week', value: '2026-W40' })];
  assert.deepEqual(propertyChanges(fields, { status: 'DONE', priority: 'must', week: '' }), { status: 'DONE', priority: 'must', week: '' });
});

test('clearing a field sends an empty value', () => {
  assert.deepEqual(propertyChanges([field('project', { value: 'Acme' })], { project: '' }), { properties: { project: '' } });
});

test('a conditional field shows only while the field it names has the value, and is not sent while hidden', () => {
  const acting = field('acting_for', { show_when: { key: 'billing', value: 'Shadowed' } });
  assert.equal(isVisible(acting, { billing: 'Shadowed' }), true);
  assert.equal(isVisible(acting, { billing: 'Billable' }), false);
  assert.equal(isVisible(field('x'), {}), true);
  const fields = [field('billing', { kind: 'select', value: 'Shadowed' }), acting];
  assert.deepEqual(propertyChanges(fields, { billing: 'Billable', acting_for: 'Al' }), { properties: { billing: 'Billable' } });
  assert.deepEqual(propertyChanges(fields, { billing: 'Shadowed', acting_for: 'Al' }), { properties: { acting_for: 'Al' } });
});

test('spacing differences are not changes', () => {
  assert.equal(propertyChanges([field('project', { value: 'Big Co' })], { project: ' Big   Co ' }), null);
});

test('a required field is missing when the save would leave it empty, as the server checks it', () => {
  const billing = field('billing', { kind: 'select', value: 'Billable' });
  const acting = field('acting_for', { required: true, show_when: { key: 'billing', value: 'Shadowed' } });
  assert.equal(missingRequired([billing, acting], { billing: 'Shadowed', acting_for: '' }), acting); // just shown, still empty
  assert.equal(missingRequired([billing, acting], { billing: 'Billable', acting_for: '' }), null); // hidden: not required
  assert.equal(missingRequired([billing, acting], { billing: 'Shadowed', acting_for: 'Al' }), null);
  const saved = [field('billing', { kind: 'select', value: 'Shadowed' }), field('acting_for', { required: true, value: '', show_when: { key: 'billing', value: 'Shadowed' } })];
  assert.equal(missingRequired(saved, { billing: 'Shadowed', acting_for: '' }), null); // untouched: the server lets it be
  assert.equal(missingRequired([field('role', { required: true, value: 'Dev' })], { role: '' }).key, 'role'); // cleared
});

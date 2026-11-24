import test from 'node:test';
import assert from 'node:assert/strict';

const s = await import('../../static/specifications/specification-note.js');

const CURRENT = `# Spine — Users

## Objective

People can sign in and out.

## Scope

Roles are in [[Spine — Roles]].

## Requirements

### Sign in

The system SHALL let a user sign in
with a password.

- valid password -> a session starts
- wrong password → sign in is refused

\`\`\`plantuml
@startuml
## not a heading
@enduml
\`\`\`

### Sign out

A user MUST be able to sign out.

## Open Questions

- Single sign-on?

## References

- backend/auth.py
`;

test('isSpecificationNote reads the type list, for specification and spec', () => {
  assert.equal(s.isSpecificationNote({ types: ['Specification'] }), true);
  assert.equal(s.isSpecificationNote({ types: ['spec'] }), true);
  assert.equal(s.isSpecificationNote({ types: ['task'] }), false);
  assert.equal(s.isSpecificationNote({}), false);
});

test('parseSpecification reads the lead, the sections in file order and the requirements', () => {
  const spec = s.parseSpecification(CURRENT);
  assert.equal(spec.lead, 'People can sign in and out.');
  assert.deepEqual(spec.sections.map((section) => section.name), ['Objective', 'Scope', 'Requirements', 'Open Questions', 'References']);
  assert.equal(spec.requirements.length, 2);
  const [signIn, signOut] = spec.requirements;
  assert.equal(signIn.name, 'Sign in');
  assert.equal(signIn.statement, 'The system SHALL let a user sign in with a password.');
  assert.equal(signIn.strong, true);
  assert.deepEqual(signIn.scenarios, [
    { when: 'valid password', then: 'a session starts' },
    { when: 'wrong password', then: 'sign in is refused' }, // the arrow may be → too
  ]);
  assert.match(signIn.rest, /^```plantuml/); // a diagram stays under its requirement; the heading inside it is not a section
  assert.match(signIn.rest, /## not a heading/);
  assert.equal(signOut.strong, true);
  assert.deepEqual(signOut.scenarios, []);
  assert.deepEqual(spec.issues, []);
  assert.equal(spec.legacy, false);
});

test('a requirement without SHALL or MUST, with too many scenarios or a repeated name is reported', () => {
  const spec = s.parseSpecification(`## Objective

x

## Requirements

### A

Users log in.

### A

The system SHALL log.

- a -> b
- c -> d
- e -> f
- g -> h
`);
  assert.deepEqual(spec.issues, [
    '"A" has no SHALL or MUST statement.',
    'Two requirements are named "A".',
    '"A" has 4 scenarios (at most 3).',
  ]);
});

test('an older specification still reads: other sections stay, and it is marked legacy', () => {
  const spec = s.parseSpecification(`Exported from Pandora.

## Introduction

Old text.

## Acceptance Criteria

- It works.
`);
  assert.deepEqual(spec.sections.map((section) => section.name), ['Introduction', 'Acceptance Criteria']);
  assert.equal(spec.legacy, true);
  assert.equal(spec.requirements.length, 0);
  assert.ok(spec.issues.includes('Has an Acceptance Criteria section: each requirement carries its own scenarios now.'));
  assert.ok(spec.issues.includes('Still has an "Exported from Pandora" line.'));
  assert.ok(spec.issues.includes('No Objective section.'));
});

test('bullet requirements without a statement keep their bullets as the rest of the requirement', () => {
  const spec = s.parseSpecification('## Requirements\n\n### Conversations\n\n- `GET /api/x` lists them.\n- All queries are tenant scoped.\n');
  const [item] = spec.requirements;
  assert.equal(item.statement, '');
  assert.equal(item.strong, false);
  assert.equal(item.rest, '- `GET /api/x` lists them.\n- All queries are tenant scoped.');
});

test('a long specification is reported', () => {
  const body = Array.from({ length: s.LONG_SPEC_LINES + 5 }, (_, i) => `Line ${i}`).join('\n\n');
  assert.ok(s.parseSpecification(`## Objective\n\n${body}\n\n## Requirements\n`).issues.some((issue) => /may cover more than one capability/.test(issue)));
});

test('verifiedAge counts whole days and rejects what is not a date', () => {
  const now = new Date(2026, 10, 24);
  assert.equal(s.verifiedAge('2026-11-20', now), 4);
  assert.equal(s.verifiedAge('2026-11-24', now), 0);
  assert.equal(s.verifiedAge('2026-12-01', now), 0);
  assert.equal(s.verifiedAge('', now), null);
  assert.equal(s.verifiedAge('soon', now), null);
  assert.equal(s.verifiedStale(null), true);
  assert.equal(s.verifiedStale(14), false);
  assert.equal(s.verifiedStale(15), true);
});

test('statusLabel gives the vault names and keeps anything else as typed', () => {
  assert.equal(s.statusLabel('active'), 'Active');
  assert.equal(s.statusLabel(' DRAFT '), 'Draft');
  assert.equal(s.statusLabel('Paused'), 'Paused');
  assert.equal(s.statusLabel(null), '');
});

test('Given / When / Then bullets are scenarios too, with or without a given and with bold keywords', () => {
  const { requirements: [item] } = s.parseSpecification(`## Requirements

### Sign in

The system SHALL sign users in.

- **Given** a registered user, **when** they enter a valid password, **then** a session starts
- When the password is wrong, then sign in is refused.
- Given: an expired account; When: they sign in; Then: they are asked to renew.
- When a Task is planned, a link SHALL propose a dependency.
- a -> b
`);
  assert.deepEqual(item.scenarios, [
    { given: 'a registered user', when: 'they enter a valid password', then: 'a session starts', gwt: true },
    { given: '', when: 'the password is wrong', then: 'sign in is refused.', gwt: true },
    { given: 'an expired account', when: 'they sign in', then: 'they are asked to renew.', gwt: true },
    { when: 'a', then: 'b' },
  ]);
  assert.match(item.rest, /^- When a Task is planned/); // prose without a "then" stays an ordinary bullet
});

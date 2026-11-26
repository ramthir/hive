import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('/static/')) return next(new URL('../../' + specifier.slice(1), ${JSON.stringify(import.meta.url)}).href, context);
    return next(specifier, context);
  }
`));
const t = await import('../../static/task-notes/task-note.js');
const { scopeGroups } = await import('../../static/notes/markdown-sections.js');

const NOTE = `# Fix login

Users on Safari cannot sign in.

## Why
Support gets calls.

## 🔍 Tasks

- [x] Reproduce
- [ ] Fix the cookie
  - [ ] nested item

\`\`\`md
## Not a heading
- [ ] not an item
\`\`\`

## Verification
Checked on Safari 17.
`;

test('isTaskNote matches the type in any case, also among several', () => {
  assert.equal(t.isTaskNote({ types: ['task'] }), true);
  assert.equal(t.isTaskNote({ types: ['Meeting', 'TASK'] }), true);
  assert.equal(t.isTaskNote({ types: ['note'] }), false);
  assert.equal(t.isTaskNote({}), false);
});

test('parseTask reads the lead, the sections in file order and counts items outside code fences', () => {
  const task = t.parseTask(NOTE);
  assert.equal(task.lead, 'Users on Safari cannot sign in.');
  assert.deepEqual(task.sections.map((s) => s.name), ['Why', '🔍 Tasks', 'Verification']);
  assert.deepEqual(task.sections.map((s) => s.kind), ['', '', 'verified']);
  assert.deepEqual([task.sections[1].done, task.sections[1].total], [1, 3]);
  assert.deepEqual(task.progress, { done: 1, total: 3 });
  assert.match(task.sections[1].body, /## Not a heading/); // inside a fence: still the section's text
});

test('a note with no headings is all lead, and an empty one has nothing', () => {
  assert.equal(t.parseTask('# T\n\nJust text.').lead, 'Just text.');
  assert.deepEqual(t.parseTask('# T\n\nJust text.').sections, []);
  assert.deepEqual(t.parseTask('').progress, { done: 0, total: 0 });
});

test('section kinds ignore leading emoji and case', () => {
  assert.equal(t.sectionKind('✅ Open Questions'), 'questions');
  assert.equal(t.sectionKind('Out of Scope'), 'out');
  assert.equal(t.sectionKind('Summary of Completed Work'), 'verified');
  assert.equal(t.sectionKind('Related Notes'), 'related');
  assert.equal(t.sectionKind('References'), 'refs');
  assert.equal(t.sectionKind('Acceptance Criteria'), 'criteria');
  assert.equal(t.sectionKind('✅ Deliverables'), 'criteria');
  assert.equal(t.sectionKind('Scope'), 'scope');
});

test('visibleTags drops status words, priorities and the project name', () => {
  assert.deepEqual(t.visibleTags(['Done', '#must', 'Acme', 'AIFI'], 'acme'), ['AIFI']);
  assert.deepEqual(t.visibleTags(undefined), []);
});

test('projectName strips wiki link brackets', () => {
  assert.equal(t.projectName('[[Acme]]'), 'Acme');
  assert.equal(t.projectName(' Acme '), 'Acme');
  assert.equal(t.projectName(undefined), '');
});

test('the read page list sends a task to /tasks and a specification that is also a task to its own page', async () => {
  const { readPagePath } = await import('/static/notes/read-pages.js');
  assert.equal(readPagePath({ slug: 'fix-login', types: ['task'] }), '/tasks/fix-login');
  assert.equal(readPagePath({ slug: 'spec', types: ['specification', 'task'] }), '/specifications/spec');
  assert.equal(readPagePath({ slug: 'idea', types: ['note'] }), '');
});

test('scopeGroups splits Scope at its In scope / Out of scope lines', () => {
  const groups = scopeGroups('Intro.\n\nIn scope:\n\n- A\n- B\n\n**Out of scope:**\n\n- C\n\n```md\nOut of scope:\n```');
  assert.deepEqual(groups.map((g) => g.kind), ['', 'in', 'out']);
  assert.equal(groups[0].body, 'Intro.');
  assert.equal(groups[1].body, '- A\n- B');
  assert.match(groups[2].body, /^- C\n\n```md\nOut of scope:/); // a line inside a fence is text, not a group
  assert.deepEqual(scopeGroups('- Only a list'), [{ kind: '', body: '- Only a list' }]);
  assert.deepEqual(scopeGroups('Out of scope\n- X').map((g) => g.kind), ['out']);
});

test('an Open Questions section counts its top-level bullets, not nested lines or fenced ones', () => {
  const task = t.parseTask('# T\n\n## Open Questions\n\n- One?\n  - detail\n- Two?\n\n```md\n- not one\n```\n\n## Plan\n\n- a\n');
  assert.equal(task.sections[0].questions, 2);
  assert.equal(task.sections[1].questions, 0);
  assert.equal(t.bulletCount(''), 0);
});

test('planSteps reads a numbered list as steps with bold names, and keeps what is above and below it', () => {
  const plan = t.planSteps('Intro line.\n\n1. **Extract the data.** Review it\n   with Serhii.\n2. **Set attributes:** Attach them.\n\n   ```yaml\n   a: 1\n   ```\n3) Plain step\n\n### Example\n\n```yaml\n1. not a step\n```');
  assert.equal(plan.before, 'Intro line.');
  assert.deepEqual(plan.steps.map((s) => s.name), ['Extract the data', 'Set attributes', '']);
  assert.equal(plan.steps[0].body, 'Review it\nwith Serhii.');
  assert.match(plan.steps[1].body, /^Attach them\.\n\n```yaml\na: 1\n```$/); // an indented fence stays in its step
  assert.equal(plan.steps[2].body, 'Plain step');
  assert.match(plan.after, /^### Example\n\n```yaml\n1\. not a step\n```$/);
});

test('a Plan with no numbered list has no steps, and the outline counts the steps of one that has', () => {
  assert.deepEqual(t.planSteps('Just a paragraph.\n\n- a bullet'), { before: 'Just a paragraph.\n\n- a bullet', steps: [], after: '' });
  assert.equal(t.parseTask('# T\n\n## Plan\n\n1. **A.** x\n2. **B.** y\n').sections[0].steps, 2);
  assert.equal(t.sectionKind('Plan'), 'plan');
});

import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import {
  ReadMarkdownSurface, renderOutline, renderReadPageShell, renderScopeGroups, wireReadPageShell,
} from '/static/notes/read-view.js';
import { highlightRequirementKeywords } from '/static/specifications/specification-view.js';
import { COLUMNS, taskChips } from '/static/tasks/card.js';
import { parseTask, planSteps } from '/static/task-notes/task-note.js';

const STATUS_TONE = { TODO: ['todo', 'neutral'], IN_PROGRESS: ['in-progress', 'blue'], DONE: ['done', 'green'] };
const SECTION_CLASS = { related: ' task-section--related', plan: ' task-section--plan', scope: ' spec-section--scope', criteria: ' task-section--criteria', questions: ' spec-section--questions', out: ' spec-section--out', refs: ' spec-section--refs task-section--refs', verified: ' task-section--verified' };

/** The read view of a task note: chips for what the board knows (status, priority, project, ticket, week, time), the progress of
    its checklists and a card per section. */
export class TaskView {
  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
    this.surface = new ReadMarkdownSurface();
  }

  markdown(text) {
    return this.surface.markdown(text);
  }

  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    this.task = parseTask(note.content);
    const status = COLUMNS.find((column) => column.value === note.task_status);
    const [statusSlug, statusTone] = STATUS_TONE[status?.value] || [];
    // The board card's chips (shared, `taskChips`) after the status and checklist progress; the time logged is in the footer.
    const chips = renderHeaderChips([
      status && { label: status.label, tone: statusTone, title: 'Status', className: `task-status--${statusSlug}` },
      this.progressChip(),
      ...taskChips({
        priority: note.priority, project: note.extra?.project, ticket: note.extra?.ticket,
        week_key: note.week, week_stored: Boolean(note.week), tags: note.tags,
      }),
    ]);
    host.innerHTML = renderReadPageShell({
      pageClass: 'spec-page',
      title: note.title,
      headerAttrs: 'bottom',
      chips,
      bodyHtml: `
        <div class="spec-workspace">
          <div class="spec-main" id="spec-main">
            ${this.body()}
          </div>
          ${this.outline()}
        </div>`,
      note,
      typeLabel,
      typeIconName,
      actions: this.actions,
    });
    wireReadPageShell(host, this.actions);
    this.surface.wireOutline(host);
    const root = host.querySelector('#spec-main');
    for (const prose of root?.querySelectorAll('.spec-prose') ?? []) highlightRequirementKeywords(prose);
    this.surface.decorate(root, note);
  }

  // "1 of 8 done" with a thin bar: a chip of the header, since it says where the task stands like the status does.
  progressChip() {
    const { done, total } = this.task.progress;
    if (!total) return null;
    const complete = done === total;
    return {
      html: `<span class="task-bar${complete ? ' task-bar--done' : ''}"><span style="width:${Math.round((done / total) * 100)}%"></span></span>${done} of ${total} done`,
      tone: complete ? 'green' : '',
      role: 'img',
      ariaLabel: `${done} of ${total} items done`,
      title: 'Checklist items done',
      className: 'task-progress',
    };
  }

  outline() {
    const entries = [];
    if (this.task.lead) entries.push({ id: 'task-lead', label: 'Summary', count: 0 });
    this.task.sections.forEach((section, index) => entries.push({ id: `task-s${index}`, label: section.name, count: section.questions || section.steps || section.total }));
    if (entries.length < 2) return '<nav class="spec-outline" aria-hidden="true"></nav>';
    return renderOutline(entries, { ariaLabel: 'Task sections' });
  }

  // A Plan written as a numbered list is drawn as steps (number, bold name, text); other text around it, or a Plan with no list, as it is.
  plan(text) {
    const { before, steps, after } = planSteps(text);
    if (!steps.length) return this.markdown(text);
    return `${before ? this.markdown(before) : ''}
      <ol class="task-steps">${steps.map((step, index) => `<li class="task-step">
        <span class="task-step-no" aria-hidden="true">${index + 1}</span>
        <div class="task-step-main">${step.name ? `<h3 class="task-step-name">${esc(step.name)}</h3>` : ''}${step.body ? `<div class="task-step-text">${this.markdown(step.body)}</div>` : ''}</div></li>`).join('')}</ol>
      ${after ? this.markdown(after) : ''}`;
  }

  body() {
    const { task } = this;
    const parts = [];
    if (task.lead) parts.push(`<section id="task-lead" class="spec-section"><div class="notes-preview-body spec-prose task-lead">${this.markdown(task.lead)}</div></section>`);
    task.sections.forEach((section, index) => {
      const pill = section.total ? `<span class="spec-pill${section.done === section.total ? ' spec-pill--ok' : ''}">${section.done} of ${section.total}</span>` : '';
      parts.push(`<section id="task-s${index}" class="spec-section task-section${section.total ? ' task-section--checks' : ''}${SECTION_CLASS[section.kind] || ''}">
        <h2 class="spec-heading">${esc(section.name)}${pill}</h2>
        <div class="notes-preview-body spec-prose">${section.kind === 'scope' ? renderScopeGroups(section.body, (c) => this.markdown(c)) : section.kind === 'plan' ? this.plan(section.body) : this.markdown(section.body)}</div></section>`);
    });
    if (!parts.length) parts.push('<p class="spec-empty">This task has no text yet. Use the pencil to write it.</p>');
    return parts.join('');
  }

  destroy() {
    this.surface.destroy();
  }
}

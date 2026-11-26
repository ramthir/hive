import { highlightRequirementKeywords, renderChecklistBar, renderOpenQuestionsSection, renderScopeSection, renderSectionCard, renderSectionProse } from '/static/notes/note-view-sections.js';
import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { TASK_STATUS_TONE, renderChip } from '/static/components/chips.js';
import {
  ReadMarkdownSurface, renderOutline, renderReadPageShell, wireReadPageShell,
} from '/static/notes/read-view.js';
import { COLUMNS, taskChips } from '/static/tasks/card.js';
import { parseTask, planSteps } from '/static/task-notes/task-note.js';

const SECTION_CLASS = { related: ' task-section--related', plan: ' task-section--plan', criteria: ' task-section--criteria', out: ' spec-section--out', refs: ' spec-section--refs task-section--refs', verified: ' task-section--verified' };

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
    // The board card's chips (shared, `taskChips`) after the status and checklist progress; the time logged is in the footer.
    const chips = renderHeaderChips([
      status && { label: status.label, tone: TASK_STATUS_TONE[status.value], title: 'Status', className: `task-status--${status.value.toLowerCase().replace('_', '-')}` },
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
      html: `${renderChecklistBar({ done, total, className: complete ? 'task-bar task-bar--done' : 'task-bar' })}${done} of ${total} done`,
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
    if (task.lead) parts.push(renderSectionCard({
      id: 'task-lead',
      bodyHtml: renderSectionProse(this.markdown(task.lead), 'task-lead'),
    }));
    task.sections.forEach((section, index) => {
      const { done, total, kind, body } = section;
      const headingHtml = total ? renderChip({ label: `${done} of ${total}`, tone: done === total ? 'green' : '' }) : '';
      const card = {
        id: `task-s${index}`,
        title: section.name,
        className: `task-section${total ? ' task-section--checks' : ''}${SECTION_CLASS[kind] || ''}`,
        headingHtml,
      };
      if (kind === 'scope') {
        parts.push(renderScopeSection({ ...card, body }, (chunk) => this.markdown(chunk)));
        return;
      }
      const renderCard = kind === 'questions' ? renderOpenQuestionsSection : renderSectionCard;
      parts.push(renderCard({
        ...card,
        bodyHtml: renderSectionProse(kind === 'plan' ? this.plan(body) : this.markdown(body)),
      }));
    });
    if (!parts.length) parts.push('<p class="spec-empty">This task has no text yet. Use the pencil to write it.</p>');
    return parts.join('');
  }

  destroy() {
    this.surface.destroy();
  }
}

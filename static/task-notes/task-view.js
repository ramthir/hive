import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/relative-time.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { chatButtonHtml } from '/static/notes/note-chat.js';
import { SpecificationView } from '/static/specifications/specification-view.js';
import { COLUMNS, PRIORITIES } from '/static/tasks/card.js';
import { canLogTime, loggedLabel } from '/static/time-entries/logged.js';
import { parseTask, planSteps, projectName, scopeGroups, visibleTags } from '/static/task-notes/task-note.js';

const STATUS_TONE = { TODO: 'todo', IN_PROGRESS: 'in-progress', DONE: 'done' };
const SECTION_CLASS = { related: ' task-section--related', plan: ' task-section--plan', scope: ' task-section--scope', criteria: ' task-section--criteria', questions: ' spec-section--questions', out: ' spec-section--out', refs: ' spec-section--refs task-section--refs', verified: ' task-section--verified' };

/** The read view of a task note: chips for what the board knows (status, priority, project, ticket, week, time), the progress of
    its checklists and a card per section. The page, markdown, diagrams and outline behave as on the specification page. */
export class TaskView extends SpecificationView {
  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    this.task = parseTask(note.content);
    const { task } = this;
    const status = COLUMNS.find((column) => column.value === note.task_status);
    const priority = PRIORITIES.find((item) => item.value === note.priority);
    const project = projectName(note.extra?.project);
    const ticket = String(note.extra?.ticket || '').trim();
    const logged = loggedLabel(note.time);
    const chips = [
      status ? `<span class="spec-pill task-status--${STATUS_TONE[status.value]}" title="Status">${esc(status.label)}</span>` : '',
      this.progressChip(),
      priority ? `<span class="spec-pill task-priority--${priority.value}" title="Priority ${priority.rank}"><i class="${priority.icon}" aria-hidden="true"></i>${esc(priority.label)}</span>` : '',
      project ? `<span class="spec-pill task-project"><i class="fa-solid fa-briefcase" aria-hidden="true"></i>${esc(project)}</span>` : '',
      ticket ? `<span class="spec-pill" title="Ticket"><i class="fa-solid fa-ticket" aria-hidden="true"></i>${esc(ticket)}</span>` : '',
      note.week ? `<span class="spec-pill" title="Week finished"><i class="fa-regular fa-calendar" aria-hidden="true"></i>${esc(note.week)}</span>` : '',
      ...visibleTags(note.tags, project).map((tag) => `<span class="spec-pill"><i class="fa-solid fa-tag" aria-hidden="true"></i>${esc(tag)}</span>`),
    ].join('');
    host.innerHTML = `
      <section class="notes-page spec-page">
        <app-header heading="${esc(note.title)}" variant="flush" bottom attached>
          <div slot="subtitle" class="spec-chips task-chips">${chips}</div>
          <div slot="actions" class="notes-header-actions app-header-action-group">${renderSearchTrigger()}</div>
        </app-header>
        <div class="spec-workspace">
          <div class="spec-main" id="spec-main">
            ${this.body()}
          </div>
          ${this.outline()}
        </div>
        <app-action-bar fixed class="notes-action-bar" aria-label="Task status and actions">
          <div class="action-bar-left notes-footer-left">
            <span class="notes-type-label"><i class="fa-solid fa-${esc(typeIconName)}" aria-hidden="true"></i><span>${esc(typeLabel)}</span></span>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="action-bar-status notes-footer-status">
              <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
                <i class="fa-regular fa-clock" aria-hidden="true"></i>
                <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
              </span>
              ${canLogTime(note) ? `<span class="stat-logged" title="Time logged on this note"${logged ? '' : ' hidden'}><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> <span>${esc(logged)}</span></span>` : ''}
            </div>
          </div>
          <div class="action-bar-right notes-footer-actions">
            <div class="map-toolbar" aria-label="Task actions">
              <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
              <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
              ${canLogTime(note) ? '<button id="log-time-btn" class="tool-button" type="button" title="Log time" aria-label="Log time"><i class="fa-solid fa-clock" aria-hidden="true"></i></button>' : ''}
              ${note.has_properties ? '<button id="note-properties-btn" class="tool-button" type="button" title="Edit note properties" aria-label="Edit note properties"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>' : ''}
              ${chatButtonHtml(this.actions.chatOpen())}
              <button id="note-versions-btn" class="tool-button" type="button" title="History" aria-label="History"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>
              <button id="edit-note-btn" class="tool-button notes-edit-toggle" type="button" title="Edit markdown" aria-label="Edit note" aria-pressed="false"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>
            </div>
          </div>
        </app-action-bar>
      </section>`;
    wireSearchTrigger(host);
    for (const [id, run] of Object.entries({
      'delete-note-btn': 'delete', 'copy-note-btn': 'copy', 'log-time-btn': 'logTime', 'note-properties-btn': 'properties',
      'note-versions-btn': 'versions', 'edit-note-btn': 'edit', 'note-chat-btn': 'chat',
    })) host.querySelector(`#${id}`)?.addEventListener('click', () => this.actions[run]());
    this.wireOutline();
    this.decorate(host.querySelector('#spec-main'));
  }

  // "1 of 8 done" with a thin bar: a chip of the header, since it says where the task stands like the status does.
  progressChip() {
    const { done, total } = this.task.progress;
    if (!total) return '';
    const complete = done === total;
    return `<span class="spec-pill task-progress${complete ? ' spec-pill--ok' : ''}" role="img" aria-label="${done} of ${total} items done" title="Checklist items done"><span class="task-bar${complete ? ' task-bar--done' : ''}"><span style="width:${Math.round((done / total) * 100)}%"></span></span>${done} of ${total} done</span>`;
  }

  outline() {
    const entries = [];
    if (this.task.lead) entries.push({ id: 'task-lead', label: 'Summary', count: 0 });
    this.task.sections.forEach((section, index) => entries.push({ id: `task-s${index}`, label: section.name, count: section.questions || section.steps || section.total }));
    if (entries.length < 2) return '<nav class="spec-outline" aria-hidden="true"></nav>';
    return `<nav class="spec-outline" aria-label="Task sections">
      <b>Sections</b>
      ${entries.map((entry) => `<a href="#${entry.id}" data-spec-link="${entry.id}"><span>${esc(entry.label)}</span>${entry.count ? `<span class="spec-count">${entry.count}</span>` : ''}</a>`).join('')}
    </nav>`;
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

  // "In scope:" and "Out of scope:" lines inside Scope each start a labelled group; without them the text is drawn as it is.
  scope(text) {
    const groups = scopeGroups(text);
    if (!groups.some((group) => group.kind)) return this.markdown(text);
    const LABELS = { in: ['In scope', 'fa-circle-check'], out: ['Out of scope', 'fa-ban'] };
    return groups.map(({ kind, body }) => {
      const [label, icon] = LABELS[kind] || [];
      return `<div class="task-scope-group${kind ? ` task-scope-group--${kind}` : ''}">
        ${label ? `<h3 class="task-scope-label"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</h3>` : ''}
        ${body ? this.markdown(body) : '<p class="spec-empty">Nothing listed.</p>'}</div>`;
    }).join('');
  }

  body() {
    const { task } = this;
    const parts = [];
    if (task.lead) parts.push(`<section id="task-lead" class="spec-section"><div class="notes-preview-body spec-prose task-lead">${this.markdown(task.lead)}</div></section>`);
    task.sections.forEach((section, index) => {
      const pill = section.total ? `<span class="spec-pill${section.done === section.total ? ' spec-pill--ok' : ''}">${section.done} of ${section.total}</span>` : '';
      parts.push(`<section id="task-s${index}" class="spec-section task-section${section.total ? ' task-section--checks' : ''}${SECTION_CLASS[section.kind] || ''}">
        <h2 class="spec-heading">${esc(section.name)}${pill}</h2>
        <div class="notes-preview-body spec-prose">${section.kind === 'scope' ? this.scope(section.body) : section.kind === 'plan' ? this.plan(section.body) : this.markdown(section.body)}</div></section>`);
    });
    if (!parts.length) parts.push('<p class="spec-empty">This task has no text yet. Use the pencil to write it.</p>');
    return parts.join('');
  }
}

import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/relative-time.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { parseTimeline, phaseMarkdown } from '/static/timelines/timeline-note.js';

/** The read view of a timeline note: one card per phase on a rail. */
export class TimelineView {
  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
  }

  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    const { phases } = parseTimeline(note.content);
    const body = phases.length
      ? `<ol class="timeline-rail">${phases.map((phase, index) => this.card(phase, index)).join('')}</ol>`
      : '<p class="timeline-empty">No phases yet. Add <code>## Month 2026 — Title</code> headings with a paragraph and a bullet list under each (the pencil edits the text).</p>';
    host.innerHTML = `
      <section class="notes-page timeline-page">
        <app-header heading="${esc(note.title)}" variant="flush" attached>
          <div slot="actions" class="notes-header-actions app-header-action-group">
            ${renderSearchTrigger()}
          </div>
        </app-header>
        <div class="timeline-workspace">
          ${body}
        </div>
        <app-action-bar fixed class="notes-action-bar" aria-label="Timeline status and actions">
          <div class="action-bar-left notes-footer-left">
            <span class="notes-type-label"><i class="fa-solid fa-${esc(typeIconName)}" aria-hidden="true"></i><span>${esc(typeLabel)}</span></span>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="action-bar-status notes-footer-status">
              <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
                <i class="fa-regular fa-clock" aria-hidden="true"></i>
                <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
              </span>
            </div>
          </div>
          <div class="action-bar-right notes-footer-actions">
            <div class="map-toolbar" aria-label="Timeline actions">
              <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
              <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
              ${note.has_properties ? '<button id="note-properties-btn" class="tool-button" type="button" title="Edit note properties" aria-label="Edit note properties"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>' : ''}
              <button id="note-versions-btn" class="tool-button" type="button" title="History" aria-label="History"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>
              <button id="edit-note-btn" class="tool-button notes-edit-toggle" type="button" title="Edit markdown" aria-label="Edit note" aria-pressed="false"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>
            </div>
          </div>
        </app-action-bar>
      </section>`;
    wireSearchTrigger(host);
    for (const [id, run] of Object.entries({
      'delete-note-btn': 'delete', 'copy-note-btn': 'copy', 'note-properties-btn': 'properties',
      'note-versions-btn': 'versions', 'edit-note-btn': 'edit',
    })) host.querySelector(`#${id}`)?.addEventListener('click', () => this.actions[run]());
    host.querySelectorAll('.timeline-phase-copy').forEach((button) => button.addEventListener('click', async () => {
      try {
        await copyTextToClipboard(phaseMarkdown(phases[Number(button.dataset.phase)]));
        const icon = button.querySelector('i');
        icon.className = 'fa-solid fa-check';
        setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 1500);
      } catch (error) {
        console.error('Failed to copy phase:', error);
      }
    }));
  }

  card(phase, index) {
    return `<li class="timeline-phase" id="phase-${index}" >
      <span class="timeline-dot" aria-hidden="true"></span>
      <span class="timeline-badge">${esc(phase.label)}</span>
      <div class="timeline-card">
        <div class="timeline-phase-head">
          <span class="timeline-phase-title">${esc(phase.title)}</span>
          <button class="tool-button timeline-phase-copy" type="button" data-phase="${index}" title="Copy this month as markdown" aria-label="Copy ${esc(phase.label || phase.title)} as markdown"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
        </div>
        <div class="timeline-phase-body">
          ${phase.summary ? `<p class="timeline-summary">${esc(phase.summary)}</p>` : ''}
          ${phase.tasks.length ? `<ul class="timeline-tasks">${phase.tasks.map((task) => `<li>${esc(task)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
    </li>`;
  }

  destroy() {}
}

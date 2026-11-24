import { escapeHtml as esc } from '/static/html.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { parseTimeline, phaseMarkdown } from '/static/timelines/timeline-note.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';

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
        ${renderReadActionBar(note, { typeLabel, typeIconName, actions: this.actions })}
      </section>`;
    wireSearchTrigger(host);
    wireReadActionBar(host, this.actions);
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

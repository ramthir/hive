import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';
import { SpecificationView } from '/static/specifications/specification-view.js';
import { parseMeetingMinutes } from '/static/meeting-minutes/meeting-minutes-note.js';

export class MeetingMinutesView extends SpecificationView {
  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    const { lead, sections } = parseMeetingMinutes(note.content);
    const entries = sections.map((section, index) => ({ ...section, id: `minutes-${index}` }));
    if (lead) entries.unshift({ id: 'minutes-summary', name: 'Summary', body: lead, tone: '' });

    const chips = renderHeaderChips([
      note.extra?.date && { label: String(note.extra.date), icon: 'fa-regular fa-calendar', title: 'Meeting date' },
      note.extra?.project && { label: String(note.extra.project), icon: 'fa-solid fa-briefcase', tone: 'blue' },
    ]);
    host.innerHTML = `
      <section class="notes-page spec-page">
        <app-header heading="${esc(note.title)}" variant="flush" bottom attached>
          ${chips}
          <div slot="actions" class="notes-header-actions app-header-action-group">${renderSearchTrigger()}</div>
        </app-header>
        <div class="spec-workspace">
          <div class="spec-main" id="minutes-main">
            ${entries.map((entry) => this.section(entry)).join('') ||
              '<p class="spec-empty">These minutes have no text yet. Use the pencil to add it.</p>'}
          </div>
          ${this.outline(entries)}
        </div>
        ${renderReadActionBar(note, { typeLabel, typeIconName, actions: this.actions })}
      </section>`;
    wireSearchTrigger(host);
    wireReadActionBar(host, this.actions);
    this.wireOutline();
    this.decorate(host.querySelector('#minutes-main'));
  }

  section({ id, name, body, tone }) {
    return `<section id="${id}" class="spec-section minutes-section${tone ? ` minutes-section--${tone}` : ''}">
      ${id === 'minutes-summary' ? '' : `<h2 class="spec-heading">${esc(name)}</h2>`}
      <div class="notes-preview-body spec-prose">${this.markdown(body)}</div>
    </section>`;
  }

  outline(entries) {
    if (entries.length < 2) return '<nav class="spec-outline" aria-hidden="true"></nav>';
    return `<nav class="spec-outline" aria-label="Meeting minutes sections">
      <b>Sections</b>
      ${entries.map(({ id, name }) => `<a href="#${id}" data-spec-link="${id}"><span>${esc(name)}</span></a>`).join('')}
    </nav>`;
  }
}

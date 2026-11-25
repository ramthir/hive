import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';
import { api } from '/static/notes/api.js';
import { SpecificationView } from '/static/specifications/specification-view.js';
import { sectionKey } from '/static/specifications/specification-note.js';
import { normalizeType } from '/static/type-icons.js';
import { actionProgress, isMeetingMinutesNote, meetingArchive, meetingParticipants, parseMeetingMinutes } from '/static/meeting-minutes/meeting-minutes-note.js';

function referenceTarget(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return (/^\[\[([^|\]#]+)(?:[|#][^\]]*)?\]\]$/.exec(text)?.[1] ?? text).trim();
}

async function showBreadcrumbs(header, note) {
  const targets = [
    referenceTarget(note.extra?.project),
    isMeetingMinutesNote(note) && referenceTarget(note.extra?.series),
  ].filter(Boolean);

  const setTrail = (resolved) => {
    if (!header.isConnected) return;
    const parents = [...new Set(targets)].flatMap((target) => {
      const hit = resolved?.[target];
      if (hit?.slug === note.slug) return [];
      return [{
        label: hit?.title ?? target,
        href: hit ? `/notes/${encodeURIComponent(hit.slug)}` : '',
      }];
    });
    header.breadcrumbs = [...parents, { label: note.title }];
  };
  if (isMeetingMinutesNote(note) && !referenceTarget(note.extra?.series)) {
    const links = await api(`/notes/${encodeURIComponent(note.slug)}/backlinks`).catch(() => null);
    const meetings = links?.backlinks.filter(({ types }) =>
      types.some((type) => normalizeType(type) === 'meeting') &&
      !isMeetingMinutesNote({ types })) || [];
    if (meetings.length === 1) {
      const { slug } = meetings[0];
      const series = await api(`/notes/${encodeURIComponent(slug)}`).catch(() => null);
      const archive = series && parseMeetingMinutes(series.content).sections.find(({ name }) => sectionKey(name) === 'minutes');
      if (archive && meetingArchive(archive.body).some(({ destination }) => {
        const target = destination.split('#', 1)[0].trim().toLowerCase();
        return target === note.slug || target === note.title.toLowerCase();
      })) targets.push(slug);
    }
  }
  if (!targets.length) return;
  setTrail();
  const query = new URLSearchParams(targets.map((target) => ['target', target]));
  const resolved = await api(`/resolve?${query}`).catch(() => null);
  if (resolved) setTrail(resolved);
}

export class MeetingMinutesView extends SpecificationView {
  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    const { lead, sections } = parseMeetingMinutes(note.content);
    const entries = sections.map((section, index) => ({ ...section, id: `minutes-${index}` }));
    const isMinutes = isMeetingMinutesNote(note);
    const archive = !isMinutes && entries.find(({ name }) => sectionKey(name) === 'minutes');
    const archiveRows = archive ? meetingArchive(archive.body) : [];
    const people = !isMinutes && entries.find(({ name }) => ['participants', 'attendees'].includes(sectionKey(name)));
    const participants = people ? meetingParticipants(people.body) : [];
    const main = participants.length ? entries.filter((entry) => entry !== people) : [...entries];
    const shortcuts = isMinutes ? entries.filter(({ tone }) => ['decisions', 'decision-points', 'actions'].includes(tone)) : [];
    if (lead) main.unshift({ id: 'minutes-summary', name: 'Summary', body: lead, tone: '' });

    const chips = renderHeaderChips([
      note.extra?.date && { label: String(note.extra.date), icon: 'fa-regular fa-calendar', title: 'Meeting date' },
    ]);
    host.innerHTML = `
      <section class="notes-page spec-page">
        <app-header heading="${esc(note.title)}" variant="flush" bottom attached breadcrumbs-in-top-padding>
          ${chips}
          <div slot="actions" class="notes-header-actions app-header-action-group">${renderSearchTrigger()}</div>
        </app-header>
        <div class="spec-workspace minutes-workspace">
          <div class="spec-main" id="minutes-main">
            ${shortcuts.length ? `<nav class="minutes-shortcuts" aria-label="Meeting highlights">
              ${shortcuts.map(({ id, name, body, tone }) => `<a href="#${id}">${esc(name)}${tone === 'actions' ? this.progress(body) : ''}</a>`).join('')}
            </nav>` : ''}
            ${main.map((entry) => entry === archive && archiveRows.length
              ? this.archive(entry, archiveRows) : this.section(entry)).join('') ||
              '<p class="spec-empty">This note has no text yet. Use the pencil to add it.</p>'}
          </div>
          ${participants.length ? this.participants(people, participants) :
            sections.length > 2 ? this.outline(main, typeLabel) : ''}
        </div>
        ${renderReadActionBar(note, { typeLabel, typeIconName, actions: this.actions })}
      </section>`;
    showBreadcrumbs(host.querySelector('app-header'), note);
    wireSearchTrigger(host);
    wireReadActionBar(host, this.actions);
    this.wireOutline();
    this.decorate(host.querySelector('.minutes-workspace'));
  }

  decorate(root) {
    if (!root) return;
    for (const item of root.querySelectorAll('.minutes-section--actions .spec-prose > :is(ul, ol) > li')) {
      const body = item.querySelector(':scope > p') || item;
      // The vault uses a trailing em dash followed by the owner's name.
      const tail = [...body.childNodes].findLast((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const owner = tail?.textContent.match(/\s—\s+([^—]+?)\s*$/u);
      if (!owner) continue;
      const label = document.createElement('em');
      label.className = 'minutes-action-owner';
      label.textContent = owner[1].replace(/\s+/g, ' ');
      tail.splitText(owner.index + owner[0].indexOf(owner[1])).replaceWith(label);
    }
    super.decorate(root);
  }

  progress(body) {
    const { done, total } = actionProgress(body);
    return total ? ` <span class="spec-count">${done}/${total}</span>` : '';
  }

  archive({ id, name }, rows) {
    const [latest] = rows;
    return `<section id="${id}" class="spec-section minutes-section minutes-archive">
      <h2 class="spec-heading">${esc(name)}</h2>
      ${latest.date !== null ? `<div class="minutes-latest">
        <strong>${esc(latest.label)}</strong>
        <div class="notes-preview-body spec-prose">${this.markdown(`[[${latest.destination}|Open latest minutes]]`)}</div>
      </div>` : ''}
      <div class="notes-preview-body spec-prose">${this.markdown(
        (latest.date !== null ? rows.slice(1) : rows).map(({ link }) => `- ${link}`).join('\n'))}</div>
    </section>`;
  }

  participants({ id, name }, rows) {
    return `<aside id="${id}" class="minutes-participants" aria-labelledby="${id}-heading">
      <h2 id="${id}-heading" class="spec-heading">${esc(name)}</h2>
      <ul>${rows.map(({ link, email }) => `<li>
        <div class="notes-preview-body spec-prose">${this.markdown(link)}</div>
        ${email ? `<details><summary>Email</summary><a href="mailto:${esc(email)}">${esc(email)}</a></details>` : ''}
      </li>`).join('')}</ul>
    </aside>`;
  }

  section({ id, name, body, tone }) {
    return `<section id="${id}" class="spec-section minutes-section${tone ? ` minutes-section--${tone}` : ''}">
      ${id === 'minutes-summary' ? '' : `<h2 class="spec-heading">${esc(name)}</h2>`}
      <div class="notes-preview-body spec-prose">${this.markdown(body)}</div>
    </section>`;
  }

  outline(entries, typeLabel) {
    const label = typeLabel === 'Meeting' ? 'Meeting sections' : 'Meeting minutes sections';
    return `<nav class="spec-outline" aria-label="${label}">
      <b>Sections</b>
      ${entries.map(({ id, name, tone, body }) => `<a href="#${id}" data-spec-link="${id}"><span>${esc(name)}</span>${tone === 'actions' ? this.progress(body) : ''}</a>`).join('')}
    </nav>`;
  }
}

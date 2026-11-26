import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';
import { api } from '/static/notes/api.js';
import { showToast } from '/static/toast.js';
import { readPagePath } from '/static/notes/read-pages.js';
import { SpecificationView } from '/static/specifications/specification-view.js';
import { sectionKey, unwrapWikilink as referenceTarget } from '/static/notes/markdown-sections.js';
import { normalizeType } from '/static/type-icons.js';
import { actionProgress, isMeetingMinutesNote, meetingArchive, meetingParticipants, minutesRow, parseMeetingMinutes, shortMinutesDate, toggleAction } from '/static/meeting-minutes/meeting-minutes-note.js';

function initial(link) {
  const [, target, alias] = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(link) || [];
  return ((alias || target || '?').trim()[0] || '?').toUpperCase();
}

async function showBreadcrumbs(header, note, cache) {
  const key = `${note.slug}\0${note.title}\0${note.extra?.project ?? ''}\0${note.extra?.series ?? ''}`;
  if (cache?.key === key) {
    if (cache.trail?.length) header.breadcrumbs = cache.trail;
    return;
  }
  const targets = [
    referenceTarget(note.extra?.project),
    isMeetingMinutesNote(note) && referenceTarget(note.extra?.series),
  ].filter(Boolean);

  let series = isMeetingMinutesNote(note) ? referenceTarget(note.extra?.series) : '';
  const setTrail = (resolved) => {
    if (!header.isConnected) return;
    const parents = [...new Set(targets)].flatMap((target) => {
      const hit = resolved?.[target];
      if (hit?.slug === note.slug) return [];
      return [{
        label: hit?.title ?? target,
        href: hit ? readPagePath(hit) || `/notes/${encodeURIComponent(hit.slug)}` : '',
      }];
    });
    // Under its series the last crumb is just the date: the crumb before it names the meeting and the heading has the full title.
    const short = series && parents.length ? shortMinutesDate(note.title) : '';
    const trail = [...parents, short ? { label: short, title: note.title } : { label: note.title }];
    if (cache) { cache.key = key; cache.trail = trail; }
    header.breadcrumbs = trail;
  };
  if (isMeetingMinutesNote(note) && !referenceTarget(note.extra?.series)) {
    const links = await api(`/notes/${encodeURIComponent(note.slug)}/backlinks`).catch(() => null);
    const meetings = links?.backlinks.filter(({ types }) =>
      types.some((type) => normalizeType(type) === 'meeting') &&
      !isMeetingMinutesNote({ types })) || [];
    if (meetings.length === 1) {
      const { slug } = meetings[0];
      const seriesNote = await api(`/notes/${encodeURIComponent(slug)}`).catch(() => null);
      const archive = seriesNote && parseMeetingMinutes(seriesNote.content).sections.find(({ name }) => sectionKey(name) === 'minutes');
      if (archive && meetingArchive(archive.body).some(({ destination }) => {
        const target = destination.split('#', 1)[0].trim().toLowerCase();
        return target === note.slug || target === note.title.toLowerCase();
      })) { targets.push(slug); series = slug; }
    }
  }
  if (!targets.length) {
    if (cache) { cache.key = key; cache.trail = null; }
    return;
  }
  // The trail waits for the answer: until then its parents would be plain text that looks like links and does nothing when clicked.
  const query = new URLSearchParams(targets.map((target) => ['target', target]));
  setTrail(await api(`/resolve?${query}`).catch(() => null));
}

function scrollParent(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
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
    const summary = lead ? { id: 'minutes-summary', name: 'Summary', body: lead, tone: '' } : null;
    // With a participants column the summary spans the full width above both columns.
    const top = summary && participants.length ? summary : null;
    if (summary && !top) main.unshift(summary);

    const actionEntry = entries.find(({ tone }) => tone === 'actions');
    const { done, total } = actionEntry ? actionProgress(actionEntry.body) : { done: 0, total: 0 };
    const chips = renderHeaderChips([
      note.extra?.date && { label: String(note.extra.date), icon: 'fa-regular fa-calendar', title: 'Meeting date' },
      participants.length > 0 && { label: `${participants.length} participant${participants.length === 1 ? '' : 's'}`, icon: 'fa-solid fa-user-group', tone: 'neutral' },
      total > 0 && { label: `${done}/${total} actions done`, icon: 'fa-solid fa-list-check', tone: done === total ? 'green' : 'orange', title: 'Action items' },
    ]);
    host.innerHTML = `
      <section class="notes-page spec-page">
        <app-header heading="${esc(note.title)}" variant="flush" bottom attached breadcrumbs-in-top-padding>
          ${chips}
          <div slot="actions" class="notes-header-actions app-header-action-group">${renderSearchTrigger()}</div>
        </app-header>
        ${top ? `<div class="minutes-top">${this.section(top)}</div>` : ''}
        <div class="spec-workspace minutes-workspace">
          <div class="spec-main" id="minutes-main">
            ${main.map((entry) => entry === archive && archiveRows.length
              ? this.archive(entry, archiveRows) : this.section(entry)).join('') ||
              '<p class="spec-empty">This note has no text yet. Use the pencil to add it.</p>'}
          </div>
          ${participants.length ? this.participants(people, participants) :
            sections.length > 2 ? this.outline(main, typeLabel) : ''}
        </div>
        ${renderReadActionBar(note, { typeLabel, typeIconName, actions: this.actions })}
      </section>`;
    this._breadcrumbCache = this._breadcrumbCache || {};
    showBreadcrumbs(host.querySelector('app-header'), note, this._breadcrumbCache);
    wireSearchTrigger(host);
    wireReadActionBar(host, this.actions);
    this.wireOutline();
    this.decorate(host.querySelector('.notes-page'));
  }

  busy() {
    return this.saving ? 'saving' : '';
  }

  // Every action item gets a box that works: one written without [ ] shows as not done and is written as [x] when ticked.
  enableActions(root) {
    let index = 0; // across every Action Items section, as toggleAction counts
    for (const prose of root.querySelectorAll('.minutes-section--actions > .spec-prose')) {
      for (const item of prose.querySelectorAll(':scope > :is(ul, ol) > li')) {
        const holder = item.querySelector(':scope > p') || item;
        let box = item.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
        if (!box) {
          box = document.createElement('input');
          box.type = 'checkbox';
          holder.prepend(box, ' ');
        }
        box.disabled = false;
        box.dataset.actionIndex = String(index++);
        box.setAttribute('aria-label', 'Done');
      }
    }
    root.addEventListener('change', (event) => {
      const box = event.target.closest?.('input[data-action-index]');
      if (box) this.markAction(box);
    });
  }

  // Ticks are saved one after the other (each is a commit on the latest text); the page is drawn again when the last one is in.
  markAction(box) {
    const index = Number(box.dataset.actionIndex);
    const done = box.checked;
    this.pending = (this.pending || 0) + 1;
    this.saving = true;
    this.queue = (this.queue || Promise.resolve()).then(() => this.saveAction(index, done, box)).finally(() => {
      this.pending -= 1;
      if (!this.pending) this.saving = false;
    });
  }

  async saveAction(index, done, box) {
    const content = toggleAction(this.note.content, index, done);
    if (content === null) { box.checked = !done; return; }
    const slug = this.note.slug;
    const scroller = scrollParent(box);
    const top = scroller?.scrollTop ?? 0;
    try {
      const saved = await api(`/notes/${encodeURIComponent(slug)}`, { method: 'PUT', body: { content, revision: this.note.revision } });
      if (this.note?.slug !== slug) return;
      this.note = saved;
      if (this.pending > 1) return; // more ticks are waiting: draw once, after the last
      this.actions.saved(saved);
      const fresh = scrollParent(this.host.querySelector('.minutes-workspace'));
      if (fresh) fresh.scrollTop = top;
    } catch (error) {
      box.checked = !done;
      if (error.status === 412) {
        showToast('This note changed elsewhere, so it was loaded again. Tick the item again.', 'info');
        this.actions.reload();
      } else {
        showToast(error.message || 'Could not save the action item.', 'error');
      }
    }
  }

  decorate(root) {
    if (!root) return;
    this.enableActions(root);
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
    const parts = rows.map((row) => minutesRow(row));
    const dated = parts.filter((_, index) => rows[index].date !== null);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    // A subtitle every row repeats, or the series' own name, says nothing the heading and page title do not.
    const shared = dated.length > 1 && dated.every(({ subtitle }) => same(subtitle, dated[0].subtitle));
    const redundant = (subtitle) => shared || same(subtitle, this.note?.title ?? '') ||
      (subtitle && (this.note?.title ?? '').toLowerCase().includes(subtitle.toLowerCase()));
    return `<section id="${id}" class="spec-section minutes-section minutes-archive">
      <h2 class="spec-heading">${esc(name)}</h2>
      <ul class="minutes-list">${rows.map((row, index) => {
        const { title, subtitle: raw, ago } = parts[index];
        const subtitle = redundant(raw) ? '' : raw;
        const link = row.date === null ? row.link : `[[${row.destination}|${title}]]`;
        return `<li>
          <div class="notes-preview-body spec-prose minutes-list-title">${this.markdown(link)}</div>
          ${subtitle ? `<span class="minutes-list-subtitle">${esc(subtitle)}</span>` : ''}
          ${ago ? `<span class="minutes-list-ago">${esc(ago)}</span>` : ''}
        </li>`;
      }).join('')}</ul>
    </section>`;
  }

  participants({ id, name }, rows) {
    return `<aside id="${id}" class="minutes-participants" aria-labelledby="${id}-heading">
      <h2 id="${id}-heading" class="spec-heading">${esc(name)}</h2>
      <ul>${rows.map(({ link }) => `<li>
        <span class="minutes-avatar" aria-hidden="true">${esc(initial(link))}</span>
        <div class="notes-preview-body spec-prose">${this.markdown(link)}</div>
      </li>`).join('')}</ul>
    </aside>`;
  }

  meter(body) {
    const { done, total } = actionProgress(body);
    if (!total) return '';
    return `<div class="minutes-meter" role="img" aria-label="${done} of ${total} actions done">
      <span style="width:${Math.round((done / total) * 100)}%"></span></div>`;
  }

  section({ id, name, body, tone }) {
    const lead = id === 'minutes-summary';
    return `<section id="${id}" class="spec-section minutes-section${tone ? ` minutes-section--${tone}` : ''}${lead ? ' minutes-section--lead' : ''}">
      ${lead ? '' : `<h2 class="spec-heading">${esc(name)}${tone === 'actions' ? `${this.meter(body)}${this.progress(body)}` : ''}</h2>`}
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

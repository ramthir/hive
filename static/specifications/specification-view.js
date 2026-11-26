import '/static/components/dropdown-menu.js'; // the menu on a rendered diagram (Download PNG)
import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { renderMarkdownPreview } from '/static/notes/markdown.js';
import { DiagramPreviews } from '/static/notes/diagrams.js';
import { Preview } from '/static/notes/preview.js'; // used for downloadDiagramPng
import { setupCodeBlockActions } from '/static/notes/code-blocks.js';
import { api } from '/static/notes/api.js';
import { decorateWikilinks, handleWikilinkClick, promptCreateNote } from '/static/notes/wikilinks.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';
import {
  parseSpecification, scopeGroups, statusLabel, verifiedAge, verifiedStale, MAX_SCENARIOS,
} from '/static/specifications/specification-note.js';
import { unwrapWikilink } from '/static/notes/markdown-sections.js';

const LEGACY_NOTICE = 'This specification is in an older format. Edit it to match the structure in the vault: Objective, Scope, Requirements (a SHALL or MUST statement and scenarios each), Out of Scope, Open Questions, References.';
const slugOf = (name) => `spec-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'}`;
const STATUS_TONE = { draft: 'neutral', active: 'green', deprecated: 'red' };

const inlineMarkdown = (text, decorate) => renderMarkdownPreview(text, { inline: true, decorate });

export function highlightRequirementKeywords(prose) {
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement.closest('a, code, pre, mark, .katex, .notes-diagram')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const parts = node.data.split(/\b(SHALL|MUST)\b/);
    if (parts.length === 1) continue;
    node.replaceWith(...parts.map((part, index) => {
      if (index % 2 === 0) return part;
      const keyword = document.createElement('mark');
      keyword.className = 'requirement-keyword';
      keyword.textContent = part;
      return keyword;
    }));
  }
}

/** The read view of a specification note: the objective, one card per requirement and the other sections, with an outline. */
export class SpecificationView {
  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
    this.diagrams = new DiagramPreviews(
      (source) => api('/diagram/render', { method: 'POST', body: { source } }),
      async (slug) => (await api(`/notes/${encodeURIComponent(slug)}`)).revision,
    );
    this.onMenu = (event) => {
      const figure = event.target.closest?.('.notes-diagram[data-diagram]');
      const theme = event.detail?.action;
      if (figure && (theme === 'dark' || theme === 'light')) Preview.prototype.downloadDiagramPng.call({ selectedNote: this.note }, figure.dataset.diagram, theme);
    };
  }

  markdown(text) {
    return renderMarkdownPreview(text, {
      isRoute: () => false,
      decorate: (parsed) => { this.diagrams.markBlocks(parsed); this.diagrams.markEmbeds(parsed); },
    });
  }

  // "In scope:" and "Out of scope:" lines inside Scope each start a labelled group; without them the text is drawn as it is.
  scope(text) {
    const groups = scopeGroups(text);
    if (!groups.some((group) => group.kind)) return this.markdown(text);
    const LABELS = { in: ['In scope', 'fa-circle-check'], out: ['Out of scope', 'fa-ban'] };
    return groups.map(({ kind, body }) => {
      const [label, icon] = LABELS[kind] || [];
      return `<div class="spec-scope-group${kind ? ` spec-scope-group--${kind}` : ''}">
        ${label ? `<h3 class="spec-scope-label"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</h3>` : ''}
        ${body ? this.markdown(body) : '<p class="spec-empty">Nothing listed.</p>'}</div>`;
    }).join('');
  }

  render(note, { typeLabel, typeIconName }) {
    const { host } = this;
    this.note = note;
    this.spec = parseSpecification(note.content);
    const { spec } = this;
    const status = statusLabel(note.status);
    const age = verifiedAge(note.extra?.verified);
    const project = unwrapWikilink(note.extra?.project);
    const chips = renderHeaderChips([
      status && { label: status, tone: STATUS_TONE[status.toLowerCase()], className: `spec-status spec-status--${status.toLowerCase()}` },
      project && { label: project, icon: 'fa-solid fa-hammer', tone: 'blue', className: 'spec-project' },
      spec.requirements.length && { label: `${spec.requirements.length} requirement${spec.requirements.length === 1 ? '' : 's'}` },
      {
        label: age === null ? 'Never verified' : age === 0 ? 'Verified today' : `Verified ${age} day${age === 1 ? '' : 's'} ago`,
        tone: verifiedStale(age) ? 'orange' : 'green',
        title: 'When it was last checked against the code (the verified property)',
      },
    ]);
    host.innerHTML = `
      <section class="notes-page spec-page">
        <app-header heading="${esc(note.title)}" variant="flush" bottom attached>
          ${chips}
          <div slot="actions" class="notes-header-actions app-header-action-group">${renderSearchTrigger()}</div>
        </app-header>
        <div class="spec-workspace">
          <div class="spec-main" id="spec-main">
            ${spec.legacy ? `<p class="spec-legacy" role="note">${esc(LEGACY_NOTICE)}</p>` : ''}
            ${this.body()}
            ${this.formatCheck()}
          </div>
          ${this.outline()}
        </div>
        ${renderReadActionBar(note, { typeLabel, typeIconName, actions: this.actions })}
      </section>`;
    wireSearchTrigger(host);
    wireReadActionBar(host, this.actions);
    this.wireOutline();
    this.decorate(host.querySelector('#spec-main'));
  }

  outline() {
    const { spec } = this;
    const sections = [];
    if (spec.lead) sections.push({ id: 'spec-objective', label: 'Objective' });
    for (const section of spec.sections) {
      if (section.key === 'objective') continue;
      const count = section.key === 'requirements' ? spec.requirements.length
        : section.key === 'open questions' ? (section.body.match(/^\s*[-*+]\s/gm) || []).length : 0;
      sections.push({ id: slugOf(section.name), label: section.name, count });
    }
    const requirements = spec.requirements.map((item, index) => `<a href="#spec-req-${index}" data-spec-link="spec-req-${index}"><span>${esc(item.name)}</span></a>`).join('');
    return `<nav class="spec-outline" aria-label="Specification sections">
      <b>Sections</b>
      ${sections.map((s) => `<a href="#${s.id}" data-spec-link="${s.id}"><span>${esc(s.label)}</span>${s.count ? `<span class="spec-count">${s.count}</span>` : ''}</a>`).join('')}
      ${requirements ? `<b class="spec-outline-gap">Requirements</b>${requirements}` : ''}
    </nav>`;
  }

  body() {
    const { spec } = this;
    const parts = [];
    if (spec.lead) parts.push(`<section id="spec-objective" class="spec-section"><p class="spec-objective spec-prose">${inlineMarkdown(spec.lead)}</p></section>`);
    for (const section of spec.sections) {
      if (section.key === 'objective') continue;
      if (section.key === 'requirements') {
        parts.push(`<section id="${slugOf(section.name)}" class="spec-section"><h2 class="spec-heading">${esc(section.name)}</h2>
          ${section.intro ? `<div class="notes-preview-body spec-prose">${this.markdown(section.intro)}</div>` : ''}
          ${spec.requirements.map((item, index) => this.requirementCard(item, index)).join('') || '<p class="spec-empty">No requirements yet. Add a <code>### Name</code> heading with a SHALL or MUST statement under it.</p>'}
        </section>`);
        continue;
      }
      const tone = { 'open questions': ' spec-section--questions', 'acceptance criteria': ' spec-section--legacy', scope: ' spec-section--scope', 'out of scope': ' spec-section--out', references: ' spec-section--refs' }[section.key] || '';
      parts.push(`<section id="${slugOf(section.name)}" class="spec-section${tone}"><h2 class="spec-heading">${esc(section.name)}</h2>
        <div class="notes-preview-body spec-prose">${section.key === 'scope' ? this.scope(section.body) : this.markdown(section.body)}</div></section>`);
    }
    if (!parts.length) parts.push(`<div class="notes-preview-body spec-prose">${this.markdown(this.note.content)}</div>`);
    return parts.join('');
  }

  requirementCard(item, index) {
    const statement = inlineMarkdown(item.statement, (doc) => highlightRequirementKeywords(doc.body));
    const many = item.scenarios.length > MAX_SCENARIOS;
    return `<article class="spec-req${item.strong ? '' : ' spec-req--weak'}" id="spec-req-${index}">
      <header class="spec-req-head">
        <h3 class="spec-req-name">${esc(item.name)}</h3>
        ${item.strong ? '' : '<span class="spec-pill spec-pill--warn">No SHALL or MUST</span>'}
        ${item.scenarios.length ? `<span class="spec-pill${many ? ' spec-pill--warn' : ''}">${item.scenarios.length} scenario${item.scenarios.length === 1 ? '' : 's'}</span>` : ''}
      </header>
      ${statement ? `<p class="spec-statement spec-prose">${statement}</p>` : ''}
      ${item.scenarios.length ? `<ol class="spec-scenarios">${item.scenarios.map((s, n) => `<li class="spec-scenario${s.given ? ' spec-scenario--given' : ''}"><span class="spec-sid" aria-hidden="true">S${n + 1}</span>${s.given ? `<span class="spec-label spec-label--given">Given</span><span class="spec-given spec-prose">${inlineMarkdown(s.given)}</span>` : ''}<span class="spec-label spec-label--when">When</span><span class="spec-when spec-prose">${inlineMarkdown(s.when)}</span><span class="spec-label spec-label--then">Then</span><span class="spec-then spec-prose">${inlineMarkdown(s.then)}</span></li>`).join('')}</ol>` : ''}
      ${item.rest ? `<div class="notes-preview-body spec-prose">${this.markdown(item.rest)}</div>` : ''}
    </article>`;
  }

  formatCheck() {
    const { issues } = this.spec;
    return `<section class="spec-check" aria-label="Format check">
      <h2 class="spec-heading">Format check</h2>
      ${issues.length ? `<ul>${issues.map((issue) => `<li class="spec-pill spec-pill--warn">${esc(issue)}</li>`).join('')}</ul>` : '<span class="spec-pill spec-pill--ok">Follows the specification structure</span>'}
    </section>`;
  }

  // Wiki links, diagrams and code blocks inside the rendered markdown behave as in the note preview.
  decorate(root) {
    if (!root) return;
    decorateWikilinks(root);
    this.diagrams.decorate(root, { editing: false });
    this.diagrams.loadEmbeds(root);
    setupCodeBlockActions(root);
    root.removeEventListener('dropdown-select', this.onMenu);
    root.addEventListener('dropdown-select', this.onMenu);
    root.addEventListener('click', (event) => handleWikilinkClick(event, {
      onNavigate: (url) => window.location.assign(url),
      onCreate: (target) => promptCreateNote(target, {
        onCreated: (created) => window.location.assign(`/notes/${encodeURIComponent(created.slug)}?mode=edit`),
      }),
    }));
  }

  // The outline marks the section in view.
  wireOutline() {
    this.observer?.disconnect();
    const links = new Map([...this.host.querySelectorAll('[data-spec-link]')].map((link) => [link.dataset.specLink, link]));
    if (typeof IntersectionObserver === 'undefined' || !links.size) return;
    this.observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach((link) => link.classList.remove('on'));
      links.get(visible.target.id)?.classList.add('on');
    }, { rootMargin: '0px 0px -70% 0px' });
    for (const id of links.keys()) {
      const target = this.host.querySelector(`#${CSS.escape(id)}`);
      if (target) this.observer.observe(target);
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.diagrams.dispose();
  }
}

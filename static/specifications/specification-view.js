import { highlightRequirementKeywords, renderOpenQuestionsSection, renderScopeSection, renderSectionCard, renderSectionProse } from '/static/notes/note-view-sections.js';
import { escapeHtml as esc } from '/static/html.js';
import { renderHeaderChips } from '/static/components/page-header.js';
import { SPEC_STATUS_TONE, renderChip } from '/static/components/chips.js';
import { renderMarkdownPreview } from '/static/notes/markdown.js';
import {
  ReadMarkdownSurface, renderOutline, renderOutlineEntry, renderReadPageShell, wireReadPageShell,
} from '/static/notes/read-view.js';
import {
  parseSpecification, statusLabel, verifiedAge, verifiedStale, MAX_SCENARIOS,
} from '/static/specifications/specification-note.js';
import { bulletCount, unwrapWikilink } from '/static/notes/markdown-sections.js';

const LEGACY_NOTICE = 'This specification is in an older format. Edit it to match the structure in the vault: Objective, Scope, Requirements (a SHALL or MUST statement and scenarios each), Out of Scope, Open Questions, References.';
const slugOf = (name) => `spec-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'}`;

const inlineMarkdown = (text, decorate) => renderMarkdownPreview(text, { inline: true, decorate });

/** The read view of a specification note: the objective, one card per requirement and the other sections, with an outline. */
export class SpecificationView {
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
    this.spec = parseSpecification(note.content);
    const { spec } = this;
    const status = statusLabel(note.status);
    const age = verifiedAge(note.extra?.verified);
    const project = unwrapWikilink(note.extra?.project);
    const chips = renderHeaderChips([
      status && { label: status, tone: SPEC_STATUS_TONE[status.toLowerCase()], className: `spec-status spec-status--${status.toLowerCase()}` },
      project && { label: project, icon: 'fa-solid fa-hammer', tone: 'blue', className: 'spec-project' },
      spec.requirements.length && { label: `${spec.requirements.length} requirement${spec.requirements.length === 1 ? '' : 's'}` },
      {
        label: age === null ? 'Never verified' : age === 0 ? 'Verified today' : `Verified ${age} day${age === 1 ? '' : 's'} ago`,
        tone: verifiedStale(age) ? 'orange' : 'green',
        title: 'When it was last checked against the code (the verified property)',
      },
    ]);
    host.innerHTML = renderReadPageShell({
      pageClass: 'spec-page',
      title: note.title,
      headerAttrs: 'bottom',
      chips,
      bodyHtml: `
        <div class="spec-workspace">
          <div class="spec-main" id="spec-main">
            ${spec.legacy ? `<p class="spec-legacy" role="note">${esc(LEGACY_NOTICE)}</p>` : ''}
            ${this.body()}
            ${this.formatCheck()}
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
    this.surface.decorate(host.querySelector('#spec-main'), note);
  }

  outline() {
    const { spec } = this;
    const sections = [];
    if (spec.lead) sections.push({ id: 'spec-objective', label: 'Objective' });
    for (const section of spec.sections) {
      if (section.key === 'objective') continue;
      const count = section.key === 'requirements' ? spec.requirements.length
        : section.key === 'open questions' ? bulletCount(section.body) : 0;
      sections.push({ id: slugOf(section.name), label: section.name, count });
    }
    const requirements = spec.requirements.map((item, index) =>
      renderOutlineEntry({ id: `spec-req-${index}`, label: item.name })).join('');
    return renderOutline(sections, {
      ariaLabel: 'Specification sections',
      extraHtml: requirements ? `<b class="spec-outline-gap">Requirements</b>${requirements}` : '',
    });
  }

  body() {
    const { spec } = this;
    const parts = [];
    if (spec.lead) parts.push(`<section id="spec-objective" class="spec-section"><p class="spec-objective spec-prose">${inlineMarkdown(spec.lead)}</p></section>`);
    for (const section of spec.sections) {
      if (section.key === 'objective') continue;
      if (section.key === 'requirements') {
        parts.push(renderSectionCard({
          id: slugOf(section.name),
          title: section.name,
          bodyHtml: [
            section.intro && renderSectionProse(this.markdown(section.intro)),
            spec.requirements.map((item, index) => this.requirementCard(item, index)).join('') ||
              '<p class="spec-empty">No requirements yet. Add a <code>### Name</code> heading with a SHALL or MUST statement under it.</p>',
          ].filter(Boolean).join(''),
        }));
        continue;
      }
      if (section.key === 'scope') {
        parts.push(renderScopeSection({
          id: slugOf(section.name),
          title: section.name,
          body: section.body,
        }, (chunk) => this.markdown(chunk)));
        continue;
      }
      const tone = { 'acceptance criteria': ' spec-section--legacy', 'out of scope': ' spec-section--out', references: ' spec-section--refs' }[section.key] || '';
      const renderCard = section.key === 'open questions' ? renderOpenQuestionsSection : renderSectionCard;
      parts.push(renderCard({
        id: slugOf(section.name),
        title: section.name,
        className: tone.trim(),
        bodyHtml: renderSectionProse(this.markdown(section.body)),
      }));
    }
    if (!parts.length) parts.push(renderSectionProse(this.markdown(this.note.content)));
    return parts.join('');
  }

  requirementCard(item, index) {
    const statement = inlineMarkdown(item.statement, (doc) => highlightRequirementKeywords(doc.body));
    const many = item.scenarios.length > MAX_SCENARIOS;
    return `<article class="spec-req${item.strong ? '' : ' spec-req--weak'}" id="spec-req-${index}">
      <header class="spec-req-head">
        <h3 class="spec-req-name">${esc(item.name)}</h3>
        ${item.strong ? '' : renderChip({ label: 'No SHALL or MUST', tone: 'orange' })}
        ${item.scenarios.length ? renderChip({ label: `${item.scenarios.length} scenario${item.scenarios.length === 1 ? '' : 's'}`, tone: many ? 'orange' : '' }) : ''}
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
      ${issues.length ? `<ul>${issues.map((issue) => renderChip({ label: issue, tone: 'orange', tag: 'li' })).join('')}</ul>` : renderChip({ label: 'Follows the specification structure', tone: 'green' })}
    </section>`;
  }

  destroy() {
    this.surface.destroy();
  }
}

import { escapeHtml as esc } from '/static/html.js';
import { scopeGroups } from '/static/notes/markdown-sections.js';

/** Render a section card. Callers supply rendered body and optional heading controls. */
export function renderSectionCard({ id, title, className = '', headingHtml = '', bodyHtml }) {
  return `<section${id ? ` id="${esc(id)}"` : ''} class="spec-section${className ? ` ${esc(className)}` : ''}">
    ${title ? `<h2 class="spec-heading">${esc(title)}${headingHtml}</h2>` : ''}
    ${bodyHtml}
  </section>`;
}

/** Wrap rendered Markdown so preview styles and link/diagram decoration apply. */
export function renderSectionProse(html, className = '') {
  return `<div class="notes-preview-body spec-prose${className ? ` ${esc(className)}` : ''}">${html}</div>`;
}

/** Render Scope text split into labelled In-scope / Out-of-scope groups when present. */
function renderScopeGroups(text, renderMarkdown) {
  const groups = scopeGroups(text);
  if (!groups.some((group) => group.kind)) return renderMarkdown(text);
  const LABELS = { in: ['In scope', 'fa-circle-check'], out: ['Out of scope', 'fa-ban'] };
  return groups.map(({ kind, body }) => {
    const [label, icon] = LABELS[kind] || [];
    return `<div class="spec-scope-group${kind ? ` spec-scope-group--${kind}` : ''}">
      ${label ? `<h3 class="spec-scope-label"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</h3>` : ''}
      ${body ? renderMarkdown(body) : '<p class="spec-empty">Nothing listed.</p>'}</div>`;
  }).join('');
}

/** Render a Scope card with shared styling and optional view-specific heading controls. */
export function renderScopeSection({ id, title, body, className = '', headingHtml }, renderMarkdown) {
  return renderSectionCard({
    id,
    title,
    className: className ? `${className} spec-section--scope` : 'spec-section--scope',
    headingHtml,
    bodyHtml: renderSectionProse(renderScopeGroups(body, renderMarkdown)),
  });
}

export function renderOpenQuestionsSection({ id, title, className = '', headingHtml, bodyHtml }) {
  return renderSectionCard({
    id,
    title,
    className: className ? `${className} spec-section--questions` : 'spec-section--questions',
    headingHtml,
    bodyHtml,
  });
}

export function renderChecklistBar({ done, total, className, ariaLabel }) {
  if (!total) return '';
  const percent = Math.round((done / total) * 100);
  return `<span class="${esc(className)}"${ariaLabel ? ` role="img" aria-label="${esc(ariaLabel)}"` : ''}><span style="width:${percent}%"></span></span>`;
}

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

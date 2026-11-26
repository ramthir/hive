import { escapeHtml as esc } from '/static/html.js';

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

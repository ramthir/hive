const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export function renderBreadcrumbTrail(breadcrumbs) {
  if (!breadcrumbs.length) return '';

  return `<nav class="page-header-breadcrumb" aria-label="Breadcrumb">${breadcrumbs
    .map(({ url = '', href = '', label = '', icon = '', title = '' }, index) => {
      const linkUrl = url || href;
      const content = `${icon ? `<i class="${escapeHtml(icon)}" aria-hidden="true"></i>` : ''}<span>${escapeHtml(label)}</span>`;
      const isLast = index === breadcrumbs.length - 1;
      const current = isLast ? ' aria-current="page"' : '';
      const separator = isLast ? '' : '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
      const hint = title ? ` title="${escapeHtml(title)}"` : '';
      return `${linkUrl ? `<a href="${escapeHtml(linkUrl)}"${current}${hint}>${content}</a>` : `<span class="page-header-crumb"${current}${hint}>${content}</span>`}${separator}`;
    })
    .join('')}</nav>`;
}

export function renderBackLink({ url = '', label = 'Back' } = {}) {
  const name = label === 'Back' ? '' : ` aria-label="Back to ${escapeHtml(label)}"`;
  return `<a href="${escapeHtml(url)}" class="back-link"${name}><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>${escapeHtml(label)}</span></a>`;
}

/**
 * A trail of one item only repeats the page the sidebar already shows, so it is hidden.
 * Two or more items are real navigation and stay.
 */
export function isRedundantBreadcrumb(breadcrumbs = []) {
  return Array.isArray(breadcrumbs) && breadcrumbs.length === 1;
}

const TONE_LEGACY_CLASS = { green: 'spec-pill--ok', orange: 'spec-pill--warn' };

/**
 * One chip in a page header's chip row (under the title in `<app-header bottom>`).
 * `tone`: 'blue' | 'green' | 'orange' | 'red' | 'neutral'. `href` renders an external link chip.
 */
export function renderHeaderChip(chip) {
  if (!chip) return '';
  if (typeof chip === 'string') return chip;
  const { label = '', html = '', icon = '', tone = '', href = '', title = '', role = '', ariaLabel = '', className = '' } = chip;
  if (!label && !html) return '';
  const classes = [
    'header-chip',
    'spec-pill',
    tone ? `header-chip--${tone}` : '',
    TONE_LEGACY_CLASS[tone] || '',
    className,
  ].filter(Boolean).join(' ');
  const attrs = [
    `class="${escapeHtml(classes)}"`,
    title ? `title="${escapeHtml(title)}"` : '',
    role ? `role="${escapeHtml(role)}"` : '',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
    href ? `href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"` : '',
  ].filter(Boolean).join(' ');
  const body = `${icon ? `<i class="${escapeHtml(icon)}" aria-hidden="true"></i>` : ''}${html || escapeHtml(label)}`;
  const tag = href ? 'a' : 'span';
  return `<${tag} ${attrs}>${body}</${tag}>`;
}

/** The slotted subtitle row of chips for `<app-header bottom>`. */
export function renderHeaderChips(chips = [], { className = '' } = {}) {
  const body = chips.map(renderHeaderChip).filter(Boolean).join('');
  if (!body) return '';
  const classes = ['header-chips', className].filter(Boolean).join(' ');
  return `<div slot="subtitle" class="${escapeHtml(classes)}">${body}</div>`;
}

export function renderPageHeader({
  title = '',
  subtitle = '',
  breadcrumbs = [],
  backLink = null,
} = {}) {
  const showBreadcrumbs = breadcrumbs.length > 0 && !isRedundantBreadcrumb(breadcrumbs);

  return `
        <header class="page-header-content">
            <div class="page-header-title">
                <div class="page-header-eyebrow"${showBreadcrumbs ? '' : ' hidden'}>
                    <slot name="eyebrow">${renderBreadcrumbTrail(breadcrumbs)}</slot>
                </div>
                <slot name="title"><h1 class="page-title">${escapeHtml(title)}</h1></slot>
                <slot name="subtitle"><p class="page-subtitle">${escapeHtml(subtitle)}</p></slot>
                <div class="page-header-meta"><slot name="meta"></slot></div>
            </div>
            <div class="page-header-actions">
                ${backLink ? renderBackLink(backLink) : '<slot name="actions"></slot>'}
            </div>
        </header>
    `;
}

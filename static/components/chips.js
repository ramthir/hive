/**
 * The one chip: a small coloured label (`.header-chip` in hive.css), used in page headers, on board cards and in
 * read pages' bodies. `tone` picks its colour; the tone maps below say which tone each status and priority gets, so a
 * value looks the same wherever it is shown.
 */
import { escapeHtml } from '../html.js';

export const TONES = Object.freeze(['neutral', 'blue', 'green', 'orange', 'red', 'purple', 'outline']);

/** A task's status (the board's columns). */
export const TASK_STATUS_TONE = Object.freeze({ TODO: 'neutral', IN_PROGRESS: 'blue', DONE: 'green' });
/** A task's priority. */
export const PRIORITY_TONE = Object.freeze({ must: 'red', important: 'orange', 'nice-to-have': 'green' });
/** A specification's status (lower case). */
export const SPEC_STATUS_TONE = Object.freeze({ draft: 'neutral', active: 'green', deprecated: 'red' });

/**
 * `{label | html, icon, tone, title, className, href, role, ariaLabel, tag}` -> chip markup ('' without a label).
 * `href` makes an external link; `tag` another element (`li`). A string is passed through as markup.
 */
export function renderChip(chip) {
  if (!chip) return '';
  if (typeof chip === 'string') return chip;
  const { label = '', html = '', icon = '', tone = '', href = '', title = '', role = '', ariaLabel = '', className = '', tag = 'span' } = chip;
  if (!label && !html) return '';
  const classes = ['header-chip', tone ? `header-chip--${tone}` : '', className].filter(Boolean).join(' ');
  const attrs = [
    `class="${escapeHtml(classes)}"`,
    title ? `title="${escapeHtml(title)}"` : '',
    role ? `role="${escapeHtml(role)}"` : '',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
    href ? `href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"` : '',
  ].filter(Boolean).join(' ');
  const body = `${icon ? `<i class="${escapeHtml(icon)}" aria-hidden="true"></i>` : ''}${html || escapeHtml(label)}`;
  const element = href ? 'a' : tag;
  return `<${element} ${attrs}>${body}</${element}>`;
}

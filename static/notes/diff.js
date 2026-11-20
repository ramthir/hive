import { escapeHtml as esc } from '/static/html.js';

const diffLineClass = (line) => {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
};

/** A unified diff as HTML: one escaped <span> per line, classed hunk / add / del. */
export function renderDiff(text) {
  if (!text.trim()) return '<span class="hunk">No changes to the note body in this version.</span>';
  return text.split('\n').map((line) => `<span class="${diffLineClass(line)}">${esc(line)}</span>`).join('\n');
}

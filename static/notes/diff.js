import { escapeHtml as esc } from '../html.js';

/* A unified diff of a note's text as numbered rows, with the changed words marked inside paired -/+ lines. */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse unified-diff text into `{ rows }`: `{ type: 'hunk'|'gap'|'ctx'|'add'|'del', no, text, hidden? }`. */
export function parseDiff(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let oldEnd = null; // line after the previous hunk's last old line
  for (const line of text.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const first = length === 0 ? start + 1 : start; // an empty old range names the line before
      const skipped = first - (oldEnd ?? 1);
      if (skipped > 0) rows.push({ type: 'gap', hidden: skipped });
      oldEnd = first + length;
      oldNo = first;
      newNo = Number(hunk[3]) || 1;
      continue;
    }
    if (oldEnd === null || line.startsWith('\\')) continue; // the ---/+++ header, "\ No newline"
    if (line.startsWith('+')) rows.push({ type: 'add', no: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ type: 'del', no: oldNo++, text: line.slice(1) });
    else if (line.startsWith(' ')) { rows.push({ type: 'ctx', no: newNo++, text: line.slice(1) }); oldNo += 1; }
  }
  return { rows };
}

const tokens = (s) => s.match(/\s+|\w+|[^\w\s]/g) || [];

/** `[oldHtml, newHtml]` with the middle part that differs wrapped in <mark>; plain if nothing is shared. */
export function markWords(oldText, newText) {
  const a = tokens(oldText);
  const b = tokens(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  if (!head && !tail) return [esc(oldText), esc(newText)];
  const wrap = (list) => `${esc(list.slice(0, head).join(''))}<mark>${esc(list.slice(head, list.length - tail).join(''))}</mark>${esc(list.slice(list.length - tail).join(''))}`;
  return [wrap(a), wrap(b)];
}

const SIGN = { add: '+', del: '−', ctx: ' ' };

/** The diff as HTML: one `.hive-diff-row` per line (number, sign, code), gaps as "N unchanged lines". */
export function renderDiff(text) {
  if (!text.trim()) return '<p class="hive-diff-empty">No changes to the text in this version.</p>';
  const { rows } = parseDiff(text);
  const html = rows.map((row) => row.html ?? esc(row.text));
  // Pair the i-th removed line with the i-th added line of the block right after it and mark the words that differ.
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type !== 'del') continue;
    let j = i;
    while (rows[j]?.type === 'del') j += 1;
    let k = j;
    while (rows[k]?.type === 'add') k += 1;
    for (let n = 0; n < Math.min(j - i, k - j); n += 1) {
      [html[i + n], html[j + n]] = markWords(rows[i + n].text, rows[j + n].text);
    }
    i = j - 1;
  }
  const body = rows.map((row, i) => (row.type === 'gap'
    ? `<div class="hive-diff-gap">${row.hidden} unchanged ${row.hidden === 1 ? 'line' : 'lines'}</div>`
    : `<div class="hive-diff-row ${row.type}"><span class="no">${row.no}</span><span class="sign" aria-hidden="true">${SIGN[row.type]}</span><span class="code">${html[i] || ' '}</span></div>`));
  return `<div class="hive-diff-rows" role="table" aria-label="Changes to the text">${body.join('')}</div>`;
}

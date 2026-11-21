import { escapeHtml as esc } from '../html.js';
import { parseUtcDate } from '../relative-time.js';
import { parseDiff, renderDiff } from './diff.js';
import { kindIcon, timeOfDay, dayLabel } from './history-list.js';

/* DOM-free pieces of the history drawer's version view: summary, property chips, text diff, restore wording. */

/** Lines added and removed in a unified diff's text. */
export function diffCounts(text) {
  const rows = parseDiff(text).rows;
  return { added: rows.filter((row) => row.type === 'add').length, removed: rows.filter((row) => row.type === 'del').length };
}

/** "3 of 47". */
export const positionLabel = (info) => (info?.total ? `${info.index} of ${info.total}` : '');

const chip = (value, cls) => (value === null || value === undefined
  ? `<span class="hive-prop-chip unset">not set</span>`
  : `<span class="hive-prop-chip ${cls}">${esc(value)}</span>`);

/** The frontmatter keys that changed: `status  IN_PROGRESS → DONE`. Bookkeeping (`updated`) is one dimmed line. '' if none. */
export function renderProperties(changes) {
  if (!changes?.length) return '';
  const rows = changes.map((change) => (change.minor
    ? `<div class="hive-prop-row minor"><span class="key">${esc(change.key)}</span><span class="note">${esc(change.old ?? 'not set')} → ${esc(change.new ?? 'removed')} · bookkeeping</span></div>`
    : `<div class="hive-prop-row"><span class="key">${esc(change.key)}</span>${change.old === null ? '' : chip(change.old, 'old')}${change.old === null ? '' : '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>'}${change.new === null ? '<span class="hive-prop-chip unset">removed</span>' : chip(change.new, 'new')}</div>`));
  return `<section class="hive-vd-section" aria-labelledby="vd-props"><h3 id="vd-props">Properties</h3><div class="hive-prop-card">${rows.join('')}</div></section>`;
}

/** The top of the version view: icon, summary, sha, author, time and the git message. */
export function renderSummary(version) {
  const kind = version.kind || 'saved';
  const detail = version.detail && kind !== 'restore' ? ` <span class="detail">· ${esc(version.detail)}</span>` : '';
  const date = parseUtcDate(version.committed_at);
  const when = date ? `${dayLabel(version.committed_at)}, ${timeOfDay(version.committed_at)}` : '';
  return `<div class="hive-vd-summary">
    <span class="hive-version-icon big kind-${esc(kind)}"><i class="fa-solid ${kindIcon(kind)}" aria-hidden="true"></i></span>
    <div><h2>${esc(version.summary || version.message)}${detail}</h2>
    <div class="meta"><code>${esc(version.sha.slice(0, 7))}</code><span>${esc(version.author)}</span><time datetime="${esc(version.committed_at)}" title="${esc(date?.toLocaleString() || '')}">${esc(when)}</time></div>
    <div class="git-message">${esc(version.message)}</div></div></div>`;
}

/** The compare toggle and the size of the change. */
export function renderCompareBar(against, info, counts) {
  const lines = counts.added || counts.removed ? `<span class="add">+${counts.added}</span> <span class="del">−${counts.removed}</span>` : '';
  const props = info.properties.filter((change) => !change.minor).length;
  const toggle = (id, label) => `<button type="button" data-against="${id}" aria-pressed="${against === id}">${label}</button>`;
  return `<div class="hive-vd-bar"><div class="hive-vd-toggle" role="group" aria-label="Compare with">${toggle('previous', 'Previous version')}${toggle('current', 'Current note')}</div>
    <div class="stat">${lines}${props ? `<span class="dim">${lines ? ' · ' : ''}${props} ${props === 1 ? 'property' : 'properties'}</span>` : ''}</div></div>`;
}

/** The whole version view for one diff response. */
export function renderVersionDetail(version, against, info) {
  const counts = diffCounts(info.diff);
  return `${renderSummary(version)}${renderCompareBar(against, info, counts)}${renderProperties(info.properties)}
    <section class="hive-vd-section" aria-labelledby="vd-text"><h3 id="vd-text">Text</h3><div class="hive-diff">${renderDiff(info.diff)}</div></section>`;
}

/** What the restore confirmation promises, as lines (the title line only when the title would change). */
export function restoreDetails(info) {
  const lines = ['The note goes back to this version as one new version. Nothing is deleted: newer versions stay in the history.'];
  if (info.version_title && info.version_title !== info.current_title) {
    lines.push(`The title was “${info.version_title}” then, so the note is renamed back to it.`);
  }
  lines.push('Any text you had not saved was saved first, so it is in the history too.');
  return lines;
}

/** "Restore the version from 3 Nov, 10:12?" */
export function restoreTitle(version) {
  const when = parseUtcDate(version.committed_at);
  return when ? `Restore the version from ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${timeOfDay(version.committed_at)}?` : 'Restore this version?';
}

import { escapeHtml as esc } from '../html.js';
import { parseUtcDate, formatRelativeTime } from '../relative-time.js';

/* DOM-free pieces of the history list: day headings, the +/- chip and the row markup. */

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** "Today", "Yesterday" or "Mon, Nov 17" for a server timestamp; `now` is injectable for tests. */
export function dayLabel(committedAt, now = new Date()) {
  const date = parseUtcDate(committedAt);
  if (!date) return '';
  if (dayKey(date) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString('en-US', options);
}

/** Markup for a version's size: `+12 −3`, or nothing when no line changed (a rename). */
export function changeChip(version) {
  const added = version.added || 0;
  const removed = version.removed || 0;
  if (!added && !removed) return '';
  return `<span class="hive-version-stat" title="${added} added, ${removed} removed"><span class="add">+${added}</span> <span class="del">−${removed}</span></span>`;
}

/** The filter chips: id, label and the version kind each one shows (`null`: all). */
export const FILTERS = [
  { id: 'all', label: 'All', kind: null },
  { id: 'text', label: 'Text', kind: 'text' },
  { id: 'properties', label: 'Properties', kind: 'properties' },
  { id: 'time', label: 'Time', kind: 'time' },
  { id: 'restores', label: 'Restores', kind: 'restore' },
];

/** The filters as the tab bar wants them: `{ id: { label } }`. */
export const filterTabs = () => Object.fromEntries(FILTERS.map((filter) => [filter.id, { label: filter.label }]));

/** Whether `version` shows under `filterId`; a version can have several kinds (text and status in one save). */
export function matchesFilter(version, filterId) {
  const kind = FILTERS.find((filter) => filter.id === filterId)?.kind;
  if (!kind) return true;
  return (version.kinds?.length ? version.kinds : [version.kind]).includes(kind);
}

const KIND_ICONS = {
  text: 'fa-pen', properties: 'fa-sliders', time: 'fa-clock', restore: 'fa-rotate-left',
  rename: 'fa-arrow-right', created: 'fa-plus', saved: 'fa-floppy-disk',
};
export const kindIcon = (kind) => KIND_ICONS[kind] || 'fa-circle';

/** Up to five squares: green for lines added, red for lines removed, in proportion. */
export function changeBar(version) {
  const added = version.added || 0;
  const removed = version.removed || 0;
  const total = added + removed;
  if (!total) return '';
  const squares = Math.min(5, total);
  let green = Math.round((squares * added) / total);
  if (added && !green) green = 1;
  if (removed && green === squares) green = squares - 1;
  return `<span class="hive-version-bar" aria-hidden="true">${'<i class="add"></i>'.repeat(green)}${'<i class="del"></i>'.repeat(squares - green)}</span>`;
}

/** "14:32" in the viewer's zone. */
export function timeOfDay(committedAt) {
  const date = parseUtcDate(committedAt);
  return date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

/** One row. `summary` is the server's words for what changed; the git message is the fallback and the tooltip. */
export function renderVersionRow(version) {
  const kind = version.kind || 'saved';
  const kinds = version.kinds?.length ? version.kinds : [kind];
  const detail = version.detail && kind !== 'restore' ? `<span class="detail"> · ${esc(version.detail)}</span>` : '';
  const restored = kind === 'restore' && version.detail ? `<span class="detail"> · ${esc(version.detail)}</span>` : '';
  const full = parseUtcDate(version.committed_at)?.toLocaleString() || '';
  return `
      <button type="button" class="hive-version-row" data-sha="${esc(version.sha)}" data-kinds="${esc(kinds.join(' '))}">
        <span class="hive-version-icon kind-${esc(kind)}"><i class="fa-solid ${kindIcon(kind)}" aria-hidden="true"></i></span>
        <span class="hive-version-main">
          <span class="msg" title="${esc(version.message)}">${esc(version.summary || version.message)}${detail}${restored}</span>
          <span class="meta"><code>${esc(version.sha.slice(0, 7))}</code><span aria-hidden="true">·</span><span>${esc(version.author)}</span><span aria-hidden="true">·</span><time datetime="${esc(version.committed_at)}" title="${esc(full)}">${esc(timeOfDay(version.committed_at))}</time></span>
        </span>
        <span class="hive-version-side">${changeChip(version)}${changeBar(version)}</span>
      </button>`;
}

/** A page of the list: a heading whenever the day changes (also against `previous`, the page before), then the rows. */
export function renderVersionList(versions, now = new Date(), previous = null) {
  let last = previous ? dayLabel(previous.committed_at, now) : null; // `previous`: the last version of the page before
  return versions.map((version) => {
    const label = dayLabel(version.committed_at, now);
    const heading = label !== last ? `<h3 class="hive-version-day">${esc(label)}</h3>` : '';
    last = label;
    return heading + renderVersionRow(version);
  }).join('');
}

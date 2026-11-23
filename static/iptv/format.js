/** Pure logic of the IPTV page (no DOM, unit-tested in tests/js/iptv.test.mjs). */
import { liveSubtitle, parseTitle, prettyGroup } from './names.js';
export { initials, liveSubtitle, parseTitle, prettyGroup, stripPrefix, titleHue } from './names.js';

export const TYPES = [
  { type: 'vod', label: 'Movies', icon: 'fa-film' },
  { type: 'series', label: 'Series', icon: 'fa-clapperboard' },
  { type: 'live', label: 'Television', icon: 'fa-tv' },
];
export const DEFAULT_TYPE = 'vod'; // the first of them: /library opens Movies
export const PAGE_SIZE = 48;

/** `?type=live&q=x` -> state. There are no pages in the address: the list loads more as it is scrolled. */
export function readState(search) {
  const p = new URLSearchParams(search);
  const type = TYPES.some((t) => t.type === p.get('type')) ? p.get('type') : DEFAULT_TYPE;
  return { type, q: p.get('q') ?? '' };
}

export function stateSearch({ type, q }) {
  const p = new URLSearchParams();
  if (type && type !== DEFAULT_TYPE) p.set('type', type);
  if (q) p.set('q', q);
  const text = p.toString();
  return text ? `?${text}` : '';
}

/** One page of the list (0-based), always newest first (the provider's "added" time; entries without one follow, by name). */
export function channelsQuery({ type, q }, page = 0) {
  const p = new URLSearchParams({ type, sort: 'latest', page: String(page), page_size: String(PAGE_SIZE) });
  if (q) p.set('q', q);
  return p.toString();
}

/** The API address that gives one stream's URL (asked for when Copy URL is pressed, so the password is not in the page). */
export function streamUrlPath(type, id, episode) {
  const p = new URLSearchParams({ type, id });
  if (episode) p.set('episode', episode);
  return `/iptv/stream-url?${p}`;
}

/** What a card shows: a clean title, its quality badge and the line beneath (live: group and note; movies and series: year and group). */
export function cardParts(item) {
  if (item.type === 'live') { // the server cleans a live channel's name and sends it apart from its quality and note
    return { title: item.display_name || item.name, quality: item.quality || '', subtitle: liveSubtitle(item.group, item.note) };
  }
  const { title, year, quality } = parseTitle(item.name);
  return { title, quality, subtitle: [year ? String(year) : '', prettyGroup(item.group)].filter(Boolean).join(' \u00b7 ') };
}

export function episodeLabel(e) {
  const code = `E${String(e.number).padStart(2, '0')}`;
  return e.title ? `${code} · ${e.title}` : code;
}

/** Episodes (already sorted by the server) -> [{ season, episodes }]. */
export function bySeason(episodes) {
  const seasons = [];
  for (const e of episodes) {
    let s = seasons.find((x) => x.season === e.season);
    if (!s) seasons.push((s = { season: e.season, episodes: [] }));
    s.episodes.push(e);
  }
  return seasons;
}

export function syncLabel(status) {
  if (!status.configured) return 'Set XTREAM_SERVER, XTREAM_USERNAME and XTREAM_PASSWORD in Hive’s .env file, then restart Hive.';
  if (status.running) return `${status.progress || 'Syncing'}…`;
  if (status.error) return `Last sync failed: ${status.error}`;
  if (!status.synced_at) return 'The catalogue is empty. Sync to load it from the provider.';
  return ''; // a good, finished sync needs no line
}

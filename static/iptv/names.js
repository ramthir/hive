// How a provider's names are shown: titles, groups, live channel lines and quality badges.

/** Up to two capital letters for a channel without a logo. */
export function initials(name) {
  const words = String(name ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

// ── Titles and posters ───────────────────────────────────────────────────────

/**
 * The provider's tag in front of a name: "IN | ", "DE: " and "IN-TM | ". A country code with a ':' or '|', or a code
 * with parts ("IN-TM", "UK_HD") or three letters with a '|'. A plain three-or-more-letter word with a ':' is part of the
 * name, as in "NCIS: Origins".
 */
export function stripPrefix(name) {
  return String(name ?? '').replace(/^(?:[A-Z]{2}\s*[:|]|[A-Z]{2,3}(?:[-_][A-Z0-9]{1,4})+\s*[:|]|[A-Z]{3}\s*\|)\s*/, '');
}

/**
 * A provider's name split into what a poster card shows: "IN | Madraskaaran (2025)" -> title "Madraskaaran",
 * year 2025. Only a two-letter capital prefix and a trailing year in brackets are removed, so titles such as
 * "NCIS: Origins" or "WWE: Raw" are left alone.
 */
export function parseTitle(name) {
  const original = String(name ?? '').trim();
  let title = stripPrefix(original);
  let quality = '';
  // A 4K tag in brackets, "(4K)" or "(4K Ultra HD)", or at the end of the name, "(2023) 4K". A 4K in the middle of a name
  // may be part of it ("4K Killer"), so it is left alone.
  title = title.replace(/\s*\((?:4K(?:\s*Ultra\s*HD)?|UHD|2160p)\)/i, () => {
    quality = '4K';
    return '';
  });
  title = title.replace(/\s+(?:4K|UHD|2160p)\s*$/i, () => {
    quality = '4K';
    return '';
  });
  let year = null;
  const match = title.match(/\s*\(((?:19|20)\d{2})\)\s*$/);
  if (match) {
    year = Number(match[1]);
    title = title.slice(0, match.index);
  }
  title = title.trim();
  return { title: title || original, year, quality: title ? quality : '' };
}

// ── Live channel names ──────────────────────────────────────────────────────────
// The server cleans a live channel's name (its prefixes, quality word and note) and sends `display_name`, `quality` and `note`.

/** The line under a live channel's name: its group (country and category) and the bracketed note, if any. */
export function liveSubtitle(group, note = '') {
  return [prettyGroup(group), String(note ?? '').trim()].filter(Boolean).join(' \u00b7 ');
}

/** "IN | TAMIL" -> "Tamil", "Films" -> "Films": a country prefix is dropped and shouting group names are softened. */
export function prettyGroup(group) {
  const trimmed = String(group ?? '').trim();
  const tagless = stripPrefix(trimmed);
  const text = (tagless !== trimmed ? tagless : trimmed.replace(/^[A-Z]{2}\s*-\s*/, '')).trim();
  if (!text) return String(group ?? '').trim();
  // "Serbia ➾ Movie", "DSTV | NEWS": the parts are shown apart by a dot, each tidied, instead of the provider's arrow or bar.
  const parts = text.split(GROUP_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.map((part, index) => (index === 0 && /^[A-Z0-9]{2,5}$/.test(part) ? part : tidyCapitals(part))).join(' \u00b7 ');
  }
  return tidyCapitals(text);
}

/** The arrows and bars providers put between a country or provider and a category, always with spaces around them. */
const GROUP_SEPARATOR = /\s+[\u27BE\u2794\u27A4\u279C\u2192\u00BB\u203A|]\s+/u;
/** Words that stay in capitals when a shouting name is tidied. */
const KEEP_CAPITALS = new Set(['HD', 'UHD', 'FHD', 'TV', 'VIP', 'PPV', 'UK', 'USA', 'UAE', 'IPL', 'NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'WWE', 'EPL', 'D2H', 'DAZN', 'HBO']);

/** A name in capitals only ("TAMIL MOVIES (VIP)") becomes "Tamil Movies (VIP)"; a name with lower case is left as it is. */
function tidyCapitals(text) {
  if (text !== text.toUpperCase() || !/[A-Z]/.test(text)) return text;
  return text
    .toLowerCase()
    .replace(/\p{L}[\p{L}\p{N}'\u2019]*/gu, (word) => (KEEP_CAPITALS.has(word.toUpperCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)));
}

/** A hue from 0 to 359 that depends only on the text, so a movie without a poster always gets the same colour. */
export function titleHue(text) {
  let hash = 0;
  for (const char of String(text ?? '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

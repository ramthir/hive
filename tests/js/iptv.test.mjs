import test from 'node:test';
import assert from 'node:assert/strict';
import { bySeason, cardParts, channelsQuery, episodeLabel, initials, liveSubtitle, parseTitle, prettyGroup, stripPrefix, readState, stateSearch, streamUrlPath, syncLabel } from '../../static/iptv/format.js';

test('the address holds the kind and the search, not a page', () => {
  assert.deepEqual(readState(''), { type: 'vod', q: '' });
  const state = readState('?type=live&q=bbc&page=3');
  assert.deepEqual(state, { type: 'live', q: 'bbc' });
  assert.equal(stateSearch(state), '?type=live&q=bbc');
  assert.equal(stateSearch(readState('')), '');
  assert.equal(readState('?type=nope').type, 'vod');
});

test('the channels query is always newest first and asks for a 0-based page', () => {
  const q = new URLSearchParams(channelsQuery({ type: 'series', q: 'a b' }, 2));
  assert.equal(q.get('type'), 'series'); assert.equal(q.get('page'), '2'); assert.equal(q.get('q'), 'a b'); assert.equal(q.get('sort'), 'latest');
  assert.equal(new URLSearchParams(channelsQuery({ type: 'vod', q: '' })).get('page'), '0');
  assert.equal(q.has('group'), false);
});

test('Copy URL asks the API for one stream, by channel and episode', () => {
  assert.equal(streamUrlPath('live', '12'), '/iptv/stream-url?type=live&id=12');
  assert.equal(streamUrlPath('series', '5', '77'), '/iptv/stream-url?type=series&id=5&episode=77');
});

test('a movie title loses the provider prefix, keeps its year apart and takes a 4K tag as the quality', () => {
  assert.deepEqual(parseTitle('IN | Madraskaaran (2025)'), { title: 'Madraskaaran', year: 2025, quality: '' });
  assert.deepEqual(parseTitle('EN|The Run (2026)'), { title: 'The Run', year: 2026, quality: '' });
  assert.deepEqual(parseTitle('IN | Pardes (1997) 4k'), { title: 'Pardes', year: 1997, quality: '4K' });
  assert.deepEqual(parseTitle('Maaveeran (2023) UHD'), { title: 'Maaveeran', year: 2023, quality: '4K' });
  assert.equal(parseTitle('IN-TM | Madraskaaran (2025)').title, 'Madraskaaran');
  assert.equal(parseTitle('Blade Runner 2049 (2017)').title, 'Blade Runner 2049');
  assert.equal(parseTitle('NCIS: Origins').title, 'NCIS: Origins');  // a word before a colon belongs to the name
  assert.equal(parseTitle('4K Killer').quality, '');
  assert.deepEqual(parseTitle(null), { title: '', year: null, quality: '' });
  assert.equal(parseTitle('(2025)').title, '(2025)');
  assert.equal(stripPrefix('DE: Isabella'), 'Isabella');
});

test('groups are tidied: the country goes, shouting is softened, parts are shown apart', () => {
  assert.equal(prettyGroup('IN | TAMIL'), 'Tamil');
  assert.equal(prettyGroup('IN-TM | TAMIL MOVIES (VIP)'), 'Tamil Movies (VIP)');
  assert.equal(prettyGroup('Serbia \u27BE Movie'), 'Serbia \u00b7 Movie');
  assert.equal(prettyGroup('Films'), 'Films');
  assert.equal(liveSubtitle('UK | NEWS', 'Spiritual'), 'News \u00b7 Spiritual');
});

test('a card shows the clean title and the line beneath it', () => {
  assert.deepEqual(cardParts({ type: 'vod', name: 'IN | Madraskaaran (2025)', group: 'IN | TAMIL' }), { title: 'Madraskaaran', quality: '', subtitle: '2025 \u00b7 Tamil' });
  assert.deepEqual(cardParts({ type: 'series', name: 'The Wire', group: 'Drama' }), { title: 'The Wire', quality: '', subtitle: 'Drama' });
  assert.deepEqual(cardParts({ type: 'live', name: 'UK: BBC One HD', display_name: 'BBC One', quality: 'HD', note: '', group: 'UK' }), { title: 'BBC One', quality: 'HD', subtitle: 'UK' });
  assert.equal(cardParts({ type: 'live', name: 'Plain' }).title, 'Plain');  // an older answer without display_name
  assert.equal(initials('BBC One'), 'BO');
});

test('episodes are grouped by season', () => {
  const seasons = bySeason([{ season: 1, number: 1 }, { season: 1, number: 2 }, { season: 2, number: 1 }]);
  assert.deepEqual(seasons.map((s) => [s.season, s.episodes.length]), [[1, 2], [2, 1]]);
  assert.equal(episodeLabel({ number: 3, title: 'Pilot' }), 'E03 · Pilot');
  assert.equal(episodeLabel({ number: 3 }), 'E03');
});

test('the sync line says what to do', () => {
  assert.match(syncLabel({ configured: false }), /XTREAM_SERVER/);
  assert.match(syncLabel({ configured: true, running: true, progress: 'Fetching movies' }), /Fetching movies/);
  assert.match(syncLabel({ configured: true, error: 'boom' }), /failed: boom/);
  assert.match(syncLabel({ configured: true }), /empty/);
  assert.equal(syncLabel({ configured: true, synced_at: '2026-11-23T12:14:03Z' }), '');  // nothing to say after a good sync
});


test('typing group: offers the categories, best matches first, and picking one replaces the word at the caret', async () => {
  const { groupSuggestions, groupTerm, insertTerm, searchToken } = await import('../../static/iptv/search.js');
  const groups = [{ name: 'IN | TAMIL', count: 5 }, { name: 'TAMIL MOVIES (VIP)', count: 3 }, { name: 'Drama', count: 9 }];
  assert.deepEqual(groupSuggestions(groups, 'raja group:tam').map((s) => s.label), ['TAMIL MOVIES (VIP)', 'IN | TAMIL']);  // starts-with first
  assert.equal(groupSuggestions(groups, 'g').length, 3);
  assert.equal(groupSuggestions(groups, 'group:').length, 3);
  assert.deepEqual(groupSuggestions(groups, 'raja'), []);  // not a group: word
  assert.deepEqual(groupSuggestions(groups, ''), []);
  assert.equal(groupSuggestions(groups, 'group:zzz').length, 0);
  assert.equal(groupSuggestions(groups, 'GROUP:dra')[0].badge, '9');
  assert.equal(groupTerm('Drama'), 'group:Drama');
  assert.equal(groupTerm('IN | TAMIL'), 'group:"IN | TAMIL"');
  assert.deepEqual(insertTerm('raja group:ta later', 12, 'group:Tamil'), { value: 'raja group:Tamil later', cursor: 17 });
  assert.deepEqual(searchToken('a bc', 3), { start: 2, end: 4, prefix: 'b' });
});

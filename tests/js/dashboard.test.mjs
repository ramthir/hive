import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diskColor, storageSegments, levelColor, processQuery, processTitle, statTiles, statusColor, storageSubHtml, storageTooltipDetails } from '../../static/dashboard/format.js';

const stats = {
  cpu: { percent: 42.26, limit: 2 },
  memory: { used: '1.0 GB', total: '4.0 GB', percent_used: 25 },
  load_average: { '1min': 3, '5min': 1.5, '15min': 1 },
  processes: { total: 12, running: 2, threads: 40 },
  storage: { used: '12.0 GB', home: '6.0 GB', notes: '83.0 MB', downloads: '5.9 GB', home_percent: 50, notes_percent: 1, downloads_percent: 49 },
  uptime: '3h 2m', in_container: true,
  app: { rss: '90.0 MB', threads: 9, open_files: 21, uptime: '1h 5m' },
};

test('gauge colours turn from green to yellow to red', () => {
  assert.deepEqual([10, 60, 80, 99].map((n) => levelColor(n)),
    ['var(--color-green)', 'var(--color-yellow)', 'var(--color-red)', 'var(--color-red)']);
});

test('the stat cards are one row: CPU, memory, load and home storage', () => {
  const tiles = Object.fromEntries(statTiles(stats).map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(tiles), ['cpu', 'memory', 'load', 'storage']);
  assert.equal(tiles.cpu.value, '42.3%');
  assert.equal(tiles.cpu.sub, 'of 2 CPUs');
  assert.equal(tiles.memory.sub, 'of 4.0 GB (25%)');
  assert.equal(tiles.load.progress, 100); // 3 load on 2 CPUs is capped at a full bar
  assert.equal(tiles.load.progressColor, 'var(--color-red)');
  assert.equal(tiles.storage.value, '12.0 GB');
  assert.equal(tiles.storage.sub, 'Notes 83.0 MB');
  assert.equal(tiles.storage.segments, '50,1,49');
});

test('without a disk reading the caption is the notes size, in its bar colour', () => {
  const html = storageSubHtml({ home: '6.0 GB', notes: '83.0 MB', downloads: '<5.9 GB' });
  assert.equal(html, '<span slot="sub">Notes <span class="sub-size" style="color:var(--color-yellow)">83.0 MB</span></span>');
  const tile = statTiles(stats).find((t) => t.key === 'storage');
  assert.equal(tile.slotHtml, storageSubHtml(stats.storage));
  assert.equal(tile.segmentColors, 'var(--color-blue),var(--color-yellow),var(--color-purple)');
});

test('storage says it is calculating until the first walk is done', () => {
  const [, , , storage] = statTiles({ ...stats, storage: { pending: true } });
  assert.deepEqual([storage.value, storage.sub, storage.segments], ['…', 'Calculating…', undefined]);
});

test('without storage or stats the cards are left out', () => {
  assert.ok(!statTiles({ ...stats, storage: null }).some((t) => t.key === 'storage'));
  assert.deepEqual(statTiles(null), []);
  assert.equal(statTiles({})[0].value, '0.0%');
});

test('a process row\'s tooltip is its full command', () => {
  assert.equal(processTitle({ name: 'python', cmdline: 'main.py' }), 'python main.py');
  assert.equal(processTitle({ name: 'tini', cmdline: '' }), 'tini');
});

test('a process state is green when running, yellow when it needs a look and quiet otherwise', () => {
  assert.equal(statusColor('running'), 'var(--color-green)');
  for (const state of ['disk-sleep', 'zombie', 'stopped']) assert.equal(statusColor(state), 'var(--color-yellow)');
  for (const state of ['sleeping', 'idle', undefined]) assert.equal(statusColor(state), 'var(--color-dimmed2)');
});

test('the dashboard page is styled by one dashboard-app rule', async () => {
  const css = await readFile(new URL('../../static/dashboard/dashboard.css', import.meta.url), 'utf8');
  assert.equal(css.match(/^dashboard-app \{/gm).length, 1);
});

test('the storage card says what is free on the disk, in the colour of how full it is', () => {
  assert.deepEqual([10, 74, 75, 89, 90, 99].map(diskColor), ['var(--color-green)', 'var(--color-green)', 'var(--color-yellow)', 'var(--color-yellow)', 'var(--color-red)', 'var(--color-red)']);
  const disk = { free: '40.2 GB', total: '453 GB', percent_used: 93 };
  const tile = statTiles({ ...stats, disk }).find((t) => t.key === 'storage');
  assert.equal(tile.sub, '40.2 GB free of 453 GB disk');
  assert.match(tile.slotHtml, /^<span slot="sub"><span class="sub-size" style="color:var\(--color-red\)">40\.2 GB<\/span> free of 453 GB disk<\/span>$/);
  assert.equal(tile.slotHtml, storageSubHtml(stats.storage, disk));
  assert.equal(statTiles(stats).find((t) => t.key === 'storage').sub.includes('free'), false); // no disk reading, no free
});

test('the process query carries page, size and sort', () => {
  assert.equal(processQuery({ page: 2, pageSize: 10, sort: 'mem_percent', direction: 'asc' }), 'page=2&page_size=10&sort=mem_percent&direction=asc');
});

test('CPU, memory and load cards carry threshold colours and storage has a tooltip breakdown', () => {
  const disk = { free: '40.2 GB', total: '453 GB', percent_used: 93 };
  const tiles = Object.fromEntries(statTiles({ ...stats, disk }).map((t) => [t.key, t]));
  assert.equal(tiles.cpu.color, 'var(--color-green)');
  assert.equal(tiles.memory.color, 'var(--color-green)');
  assert.equal(tiles.load.color, 'var(--color-red)');
  assert.equal(tiles.storage.attrs['data-tooltip-title'], 'Storage');
  const details = storageTooltipDetails(stats.storage, disk);
  assert.deepEqual(details.map((r) => r.label), ['Home', 'Notes', 'Downloads', 'Disk Free']);
  assert.equal(details[3].color, 'var(--color-red)');
});

test('with a disk reading the bar pieces are shares of the disk and the rest of the track is free', () => {
  const storage = { ...stats.storage, used_bytes: 12e9 };
  assert.deepEqual(storageSegments(storage), [50, 1, 49]); // no disk: the home folder fills the bar
  const disk = { free: '40.2 GB', total: '453 GB', total_bytes: 120e9, percent_used: 60 };
  assert.deepEqual(storageSegments(storage, disk), [5, 1.5, 4.9]); // Notes is 0.1% of the disk, kept visible
  const tile = statTiles({ ...stats, storage, disk }).find((t) => t.key === 'storage');
  assert.equal(tile.segments, '5,1.5,4.9');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { levelColor, processTitle, statTiles, statusColor, storageSubHtml } from '../../static/dashboard/format.js';

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
  assert.equal(tiles.storage.sub, 'Home 6.0 GB\u2003Notes 83.0 MB\u2003Downloads 5.9 GB');
  assert.equal(tiles.storage.segments, '50,1,49');
});

test('each storage size is drawn in the colour of its piece of the bar', () => {
  const html = storageSubHtml({ home: '6.0 GB', notes: '83.0 MB', downloads: '<5.9 GB' });
  assert.match(html, /^<span slot="sub">Home <span class="sub-size" style="color:var\(--color-blue\)">6\.0 GB<\/span>/);
  assert.match(html, /Notes <span class="sub-size" style="color:var\(--color-yellow\)">83\.0 MB/);
  assert.match(html, /Downloads <span class="sub-size" style="color:var\(--color-purple\)">&lt;5\.9 GB/);
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

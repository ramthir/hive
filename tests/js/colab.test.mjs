import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PAGE_SIZE, chooseSession, gpuSummary, headerStatus, machineTiles, pickerItems, processPage, statusText, streamIsLive, waitingReason, uptimeText, uptimeTile, usageColor, usageTiles } from '../../static/colab/format.js';

const SESSION = { name: 'sentinel-run', runtime_id: 'm-s-1', hardware: 'GPU', shape: 'Standard', variant: 'T4' };
const stats = (extra = {}) => ({ cpu_count: 2, cpu_percent: 42.26, load_average: { '1min': 1.14, '5min': 0.73, '15min': 0.38 }, uptime: '1:05',
  memory: { used_gb: 1.2, total_gb: 12.7, percent: 9.4 }, disk: { used_gb: 30, total_gb: 100, percent: 30 }, gpu: [], ...extra });
const gpu = { name: 'Tesla T4', utilization_percent: 91, memory_used_mb: 4096, memory_total_mb: 15360, memory_percent: 26.7 };

test('gauge colours turn from green to yellow at 60 and red at 80, like the Debian tab', () => {
  assert.deepEqual([10, 59, 60, 79, 80, 99].map(usageColor), ['var(--color-green)', 'var(--color-green)', 'var(--color-yellow)', 'var(--color-yellow)', 'var(--color-red)', 'var(--color-red)']);
});

test('the usage cards show the balance, the burn rate and the assignments', () => {
  const [balance, rate, assignments] = usageTiles({ reachable: true, balance: 499.975, usage_rate: 0.08, usage_rate_unit: '/hr', active_assignments: 1 });
  assert.deepEqual([balance.value, rate.value, rate.sub, assignments.value, assignments.sub], ['499.98', '0.08/hr', 'Active burn rate', 1, '']);
  assert.equal(rate.color, 'var(--color-yellow)');
});

test('an idle runtime says Idle and no active session', () => {
  const [, rate, assignments] = usageTiles({ reachable: true, balance: 10, usage_rate: 0, usage_rate_unit: '/hr', active_assignments: 0 });
  assert.deepEqual([rate.sub, rate.color, assignments.sub], ['Idle', 'var(--color-dimmed2)', 'No active session']);
});

test('usage that could not be read says so on every card, never a number', () => {
  for (const input of [null, { reachable: false, error: 'colab usage timed out' }]) {
    assert.deepEqual(usageTiles(input).map((t) => [t.value, t.sub]), [['-', 'Unable to read'], ['-', 'Unable to read'], ['-', 'Unable to read']]);
  }
});

test('uptime spells out hours and minutes and names the runtime', () => {
  assert.equal(uptimeText('1:05'), '1h 05m');
  assert.equal(uptimeText('18 min'), '18 min');
  assert.equal(uptimeText(undefined), '-');
  assert.deepEqual(uptimeTile(stats(), SESSION, 'sentinel-run'), { key: 'uptime', value: '1h 05m', sub: 'sentinel-run · GPU' });
  assert.deepEqual(uptimeTile(null, null, null), { key: 'uptime', value: '-', sub: 'No active session' });
  assert.equal(uptimeTile(null, null, 'chosen').sub, 'chosen');
});

test('without a GPU the machine cards are CPU, memory, storage and load', () => {
  const tiles = machineTiles(stats(), SESSION);
  assert.deepEqual(tiles.map((t) => t.key), ['cpu', 'memory', 'disk', 'load']);
  const [cpu, memory, disk, load] = tiles;
  assert.deepEqual([cpu.value, cpu.sub, cpu.progress], ['42.3%', '2 vCPUs · GPU (Standard)', 42.26]);
  assert.deepEqual([memory.value, memory.sub], ['1.2 GB', 'of 12.7 GB (9.4%)']);
  assert.deepEqual([disk.value, disk.sub, disk.title], ['30.0 GB', 'of 100.0 GB (30%)', 'Storage (/content)']);
  assert.deepEqual([load.value, load.sub], ['1.14', '5m: 0.73 / 15m: 0.38']);
});

test('with a GPU its card takes the load average\'s place, right after the CPU', () => {
  const tiles = machineTiles(stats({ gpu: [gpu] }), SESSION);
  assert.deepEqual(tiles.map((t) => t.key), ['cpu', 'gpu', 'memory', 'disk']);
  assert.deepEqual([tiles[1].value, tiles[1].sub, tiles[1].color], ['91%', 'Tesla T4 · VRAM 4.0/15.0 GB (26.7%)', 'var(--color-red)']);
});

test('before the first collection every card is a dash with an empty bar', () => {
  const tiles = machineTiles(null, null);
  assert.deepEqual(tiles.map((t) => t.value), ['-', '-', '-', '-']);
  assert.ok(tiles.slice(0, 3).every((t) => t.progress === 0 && t.color === ''));
  assert.equal(tiles[0].sub, '-');
});

test('one vCPU is singular and a bar never passes its ends', () => {
  assert.match(machineTiles(stats({ cpu_count: 1 }), null)[0].sub, /^1 vCPU$/);
  assert.equal(machineTiles(stats({ cpu_percent: 140 }), null)[0].progress, 100);
});

test('a ready stream event says nothing; a paused one says why and when the data is from', () => {
  assert.deepEqual(statusText({ status: 'ready', message: '' }), { notice: '', error: '' });
  assert.deepEqual(statusText({ status: 'loading' }), { notice: '', error: '' });
  const paused = statusText({ status: 'waiting', message: 'Notebook kernel is busy; monitoring is paused. Showing the last collected data.', last_updated: '2026-11-21T10:15:30+00:00' });
  assert.match(paused.notice, /busy; monitoring is paused\. Showing the last collected data\. Last updated \d\d:\d\d:\d\d\.$/);
  assert.equal(paused.error, '');
});

test('a failed collection is an error, never a notice', () => {
  const failed = statusText({ status: 'unavailable', message: 'Unable to collect Colab status.', last_updated: null });
  assert.deepEqual(failed, { notice: '', error: 'Unable to collect Colab status.' });
  assert.match(statusText({ status: 'unavailable' }).error, /Unable to collect Colab status/);
});

const procs = (n) => Array.from({ length: n }, (_, i) => ({ pid: i + 1, name: `p${i + 1}`, cpu_percent: i % 5, mem_percent: (n - i) % 7 }));

test('processes are paged ten at a time, highest CPU first with the lower pid first on a tie', () => {
  const page = processPage(procs(25));
  assert.equal(PAGE_SIZE, 10);
  assert.deepEqual([page.total, page.totalPages, page.items.length], [25, 3, 10]);
  assert.deepEqual(page.items.slice(0, 3).map((p) => [p.cpu_percent, p.pid]), [[4, 5], [4, 10], [4, 15]]);
});

test('sorting by memory uses the memory share, and ascending reverses the order', () => {
  const asc = processPage(procs(8), { sort: 'mem', dir: 'asc' });
  const shares = asc.items.map((p) => p.mem_percent);
  assert.deepEqual(shares, [...shares].sort((a, b) => a - b));
});

test('a page past the end is the last page, and an empty list is one empty page', () => {
  assert.equal(processPage(procs(25), { page: 9 }).page, 2);
  assert.equal(processPage(procs(25), { page: -3 }).page, 0);
  assert.deepEqual(processPage([], {}), { items: [], total: 0, totalPages: 1, page: 0, pageSize: 10 });
  assert.equal(processPage(undefined).total, 0);
});

test('the picked runtime stays while it is active, otherwise the first one is shown', () => {
  const sessions = [SESSION, { ...SESSION, name: 'other', runtime_id: 'm-s-2' }];
  assert.equal(chooseSession(sessions, 'other'), 'other');
  assert.equal(chooseSession(sessions, 'gone'), 'sentinel-run');
  assert.equal(chooseSession(sessions, null), 'sentinel-run');
  assert.equal(chooseSession([], 'other'), null);
  assert.equal(chooseSession(undefined, null), null);
  assert.deepEqual(pickerItems(sessions, 'other').map((i) => [i.name, i.active]), [['sentinel-run', false], ['other', true]]);
});

test('the Colab tab is scoped to itself, has no breakpoints, and the page loads it', async () => {
  const css = await readFile(new URL('../../static/colab/colab.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@media|:host/);
  const selectors = css.split('\n').filter((line) => /^[a-z.]/.test(line)).map((line) => line.split(/[ ,{]/)[0]);
  assert.ok(selectors.every((first) => first === 'colab-tab'), 'every rule is scoped to the tab');
  const html = await readFile(new URL('../../static/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /\/static\/colab\/colab\.css/);
  const page = await readFile(new URL('../../static/dashboard/dashboard-page.js', import.meta.url), 'utf8');
  assert.match(page, /\/static\/colab\/colab-tab\.js/);
});

test('a stream the browser closed is not live, so the next poll opens a new one', () => {
  const open = { readyState: 1 }, connecting = { readyState: 0 }, closed = { readyState: 2 };
  assert.equal(streamIsLive(open, 'a', 'a'), true);
  assert.equal(streamIsLive(connecting, 'a', 'a'), true); // the browser is reconnecting by itself
  assert.equal(streamIsLive(closed, 'a', 'a'), false);
  assert.equal(streamIsLive(open, 'a', 'b'), false);
  assert.equal(streamIsLive(null, null, 'a'), false);
});

test('the header line shows a stream error first, then what the polled reads say, then a stream notice', () => {
  assert.deepEqual(headerStatus({ stream: { error: 'probe failed' }, pollErrors: ['usage down'] }), { text: 'probe failed', error: true });
  assert.deepEqual(headerStatus({ stream: { notice: 'paused' }, pollErrors: ['usage down', 'usage down', 'sessions down'] }), { text: 'usage down · sessions down', error: true });
  assert.deepEqual(headerStatus({ stream: { notice: 'paused' }, pollErrors: [] }), { text: 'paused', error: false });
  assert.deepEqual(headerStatus(), { text: '', error: false });
});

test('a runtime with no data yet says why, instead of loading for ever', () => {
  assert.equal(waitingReason(null, { status: 'waiting', message: 'Notebook kernel is busy; monitoring is paused.' }), 'Notebook kernel is busy; monitoring is paused.');
  assert.equal(waitingReason(null, { status: 'unavailable', message: '' }), 'Unable to collect Colab status.');
  assert.equal(waitingReason(null, { status: 'inactive' }), 'This Colab runtime is no longer active.');
  assert.equal(waitingReason(null, { status: 'loading' }), ''); // the first probe is still running
  assert.equal(waitingReason(null, null), '');
  assert.equal(waitingReason({ uptime: '1:05' }, { status: 'waiting', message: 'busy' }), ''); // the last good stats stay on screen
});

test('several GPUs are one card: the average load, the names and the VRAM added up', () => {
  const two = [gpu, { ...gpu, utilization_percent: 50, memory_used_mb: 2048, memory_percent: 13.3 }];
  const tiles = machineTiles(stats({ gpu: two }), SESSION);
  assert.deepEqual(tiles.map((t) => t.key), ['cpu', 'gpu', 'memory', 'disk']);
  assert.deepEqual([tiles[1].value, tiles[1].sub, tiles[1].progress], ['70.5%', '2× Tesla T4 · VRAM 6.0/30.0 GB (20%)', 70.5]);
  assert.equal(gpuSummary([gpu, { ...gpu, name: 'A100' }]).sub.startsWith('2× Tesla T4 + A100'), true);
  assert.equal(gpuSummary([{ name: 'Tesla T4' }]).value, '-'); // nothing measured yet
  // Idle compute with nearly full VRAM still highlights VRAM pressure in red.
  assert.equal(gpuSummary([{ name: 'Tesla T4', utilization_percent: 0, memory_used_mb: 14000, memory_total_mb: 15360, memory_percent: 91.1 }]).color, 'var(--color-red)');
});

test('Colab processes can be filtered by name or command before paging', () => {
  const list = [
    { pid: 1, name: 'python3', cmdline: 'train.py --epochs 10', cpu_percent: 80, mem_percent: 20 },
    { pid: 2, name: 'jupyter', cmdline: 'notebook', cpu_percent: 5, mem_percent: 4 },
  ];
  const byCmd = processPage(list, { q: 'TRAIN.PY' });
  assert.deepEqual(byCmd.items.map((p) => p.name), ['python3']);
  assert.equal(byCmd.total, 1);
  assert.equal(processPage(list, { q: 'missing' }).total, 0);
});

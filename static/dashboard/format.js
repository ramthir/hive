/** What the dashboard's stat cards and process table show, kept free of DOM access so it can be unit-tested. */

/** Green below `warn`, yellow below `crit`, red above: the colour of a gauge. */
export function levelColor(percent, warn = 60, crit = 80) {
  const value = Number(percent) || 0;
  if (value < warn) return 'var(--color-green)';
  if (value < crit) return 'var(--color-yellow)';
  return 'var(--color-red)';
}

/** The colour of the disk's free space: green until it is three quarters full, yellow to nine tenths, then red. */
export const diskColor = (percentUsed) => levelColor(percentUsed, 75, 90);

export const STORAGE_COLORS = { home: 'var(--color-blue)', notes: 'var(--color-yellow)', downloads: 'var(--color-purple)' };
const STORAGE_NAMES = { home: 'Home', notes: 'Notes', downloads: 'Downloads' };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The line under the Storage value: each size in the colour of its piece of the bar. */
export function storageSubHtml(storage, disk = null) {
  const parts = Object.keys(STORAGE_NAMES).map((key) =>
    `${STORAGE_NAMES[key]} <span class="sub-size" style="color:${STORAGE_COLORS[key]}">${esc(storage[key])}</span>`);
  // What is left on the disk, in the colour of how full it is: a filling disk is the thing to notice.
  if (disk) parts.push(`Free <span class="sub-size" style="color:${diskColor(disk.percent_used)}">${esc(disk.free)}</span>`);
  return `<span slot="sub">${parts.join('\u2003')}</span>`;
}

/** Rich tooltip rows for the Storage card, so clipped sizes on narrower screens stay readable on hover. */
export function storageTooltipDetails(storage, disk = null) {
  const rows = Object.keys(STORAGE_NAMES).map((key) => ({
    label: STORAGE_NAMES[key],
    value: String(storage[key] ?? ''),
    color: STORAGE_COLORS[key],
  }));
  if (disk) {
    rows.push({
      label: 'Disk Free',
      note: disk.percent_used != null ? `· ${disk.percent_used}% used` : '',
      value: String(disk.free ?? ''),
      color: diskColor(disk.percent_used),
    });
  }
  return rows;
}

/** One-line container summary shown beside the process filter: uptime, processes and threads. */
export function containerSummary(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.uptime) parts.push(`Up ${stats.uptime}`);
  const procs = stats.processes;
  if (procs && typeof procs.total === 'number') {
    parts.push(`${procs.total} ${procs.total === 1 ? 'process' : 'processes'}`);
    if (typeof procs.threads === 'number') parts.push(`${procs.threads} ${procs.threads === 1 ? 'thread' : 'threads'}`);
  }
  return parts.join(' · ');
}

const clamp = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));

/**
 * The stat cards for `GET /api/system/stats`, as props for `renderStatCard`. CPU is the share of the container's CPU
 * limit; load average is judged against the CPUs the container may use.
 */
export function statTiles(stats) {
  if (!stats) return [];
  const cpu = stats.cpu || {};
  const mem = stats.memory || {};
  const load = stats.load_average || {};
  const storage = stats.storage;
  const disk = stats.disk;
  const limit = Number(cpu.limit) || 1;
  const loadPercent = ((Number(load['1min']) || 0) / limit) * 100;
  const cpuColor = levelColor(cpu.percent);
  const memColor = levelColor(mem.percent_used);
  const loadColor = levelColor(loadPercent, 70, 100);
  const tiles = [
    { key: 'cpu', icon: 'fa-microchip', title: 'CPU', value: `${(Number(cpu.percent) || 0).toFixed(1)}%`,
      sub: `of ${limit} ${limit === 1 ? 'CPU' : 'CPUs'}`, color: cpuColor, progress: clamp(cpu.percent), progressColor: cpuColor },
    { key: 'memory', icon: 'fa-memory', title: 'Memory', value: mem.used || 'N/A',
      sub: `of ${mem.total || 'N/A'} (${Number(mem.percent_used) || 0}%)`, color: memColor, progress: clamp(mem.percent_used), progressColor: memColor },
    { key: 'load', icon: 'fa-chart-line', title: 'Load Average', value: (Number(load['1min']) || 0).toFixed(2),
      sub: `5m: ${(Number(load['5min']) || 0).toFixed(2)} / 15m: ${(Number(load['15min']) || 0).toFixed(2)}`,
      color: loadColor, progress: clamp(loadPercent), progressColor: loadColor },
  ];
  if (storage?.pending) {
    tiles.push({ key: 'storage', icon: 'fa-hard-drive', title: 'Storage', value: '…', sub: 'Calculating…', progress: 0 });
  } else if (storage) {
    // Home (what is left of it), Notes and Downloads never overlap, so the bar is the whole home folder.
    tiles.push({ key: 'storage', icon: 'fa-hard-drive', title: 'Storage', value: storage.used,
      sub: `Home ${storage.home}\u2003Notes ${storage.notes}\u2003Downloads ${storage.downloads}${disk ? `\u2003Free ${disk.free}` : ''}`, slotHtml: storageSubHtml(storage, disk),
      progress: 100, segments: [storage.home_percent, storage.notes_percent, storage.downloads_percent].join(','),
      segmentColors: [STORAGE_COLORS.home, STORAGE_COLORS.notes, STORAGE_COLORS.downloads].join(','),
      attrs: { 'data-tooltip-title': 'Storage', 'data-tooltip-no-total': true, 'data-tooltip-details': JSON.stringify(storageTooltipDetails(storage, disk)) } });
  }
  return tiles;
}

/** The tooltip of a process row: its full command, or just its name. */
export function processTitle(p) {
  return p.cmdline ? `${p.name} ${p.cmdline}` : p.name;
}

/** The colour of a process's CPU or memory percentage. */
export function processColor(percent) {
  return levelColor(percent, 50, 80);
}

/** The colour of a process's state: running is green, a wait on the disk, a zombie or a stopped process draws the eye, the rest is quiet. */
export function statusColor(status) {
  if (status === 'running') return 'var(--color-green)';
  if (status === 'disk-sleep' || status === 'zombie' || status === 'stopped') return 'var(--color-yellow)';
  return 'var(--color-dimmed2)';
}

/** The query string of one page of processes; the filter is left out while it is empty. */
export function processQuery({ page, pageSize, sort, direction, q = '' }) {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize), sort, direction });
  if (q.trim()) query.set('q', q.trim());
  return query.toString();
}

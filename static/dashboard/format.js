/** What the dashboard's stat cards and process table show, kept free of DOM access so it can be unit-tested. */

/** Green below `warn`, yellow below `crit`, red above: the colour of a gauge. */
export function levelColor(percent, warn = 60, crit = 80) {
  const value = Number(percent) || 0;
  if (value < warn) return 'var(--color-green)';
  if (value < crit) return 'var(--color-yellow)';
  return 'var(--color-red)';
}

export const STORAGE_COLORS = { home: 'var(--color-blue)', notes: 'var(--color-yellow)', downloads: 'var(--color-purple)' };
const STORAGE_NAMES = { home: 'Home', notes: 'Notes', downloads: 'Downloads' };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The line under the Storage value: each size in the colour of its piece of the bar. */
export function storageSubHtml(storage) {
  const parts = Object.keys(STORAGE_NAMES).map((key) =>
    `${STORAGE_NAMES[key]} <span class="sub-size" style="color:${STORAGE_COLORS[key]}">${esc(storage[key])}</span>`);
  return `<span slot="sub">${parts.join('\u2003')}</span>`;
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
  const limit = Number(cpu.limit) || 1;
  const loadPercent = ((Number(load['1min']) || 0) / limit) * 100;
  const tiles = [
    { key: 'cpu', icon: 'fa-microchip', title: 'CPU', value: `${(Number(cpu.percent) || 0).toFixed(1)}%`,
      sub: `of ${limit} ${limit === 1 ? 'CPU' : 'CPUs'}`, progress: clamp(cpu.percent), progressColor: levelColor(cpu.percent) },
    { key: 'memory', icon: 'fa-memory', title: 'Memory', value: mem.used || 'N/A',
      sub: `of ${mem.total || 'N/A'} (${Number(mem.percent_used) || 0}%)`, progress: clamp(mem.percent_used), progressColor: levelColor(mem.percent_used) },
    { key: 'load', icon: 'fa-chart-line', title: 'Load Average', value: (Number(load['1min']) || 0).toFixed(2),
      sub: `5m: ${(Number(load['5min']) || 0).toFixed(2)} / 15m: ${(Number(load['15min']) || 0).toFixed(2)}`,
      progress: clamp(loadPercent), progressColor: levelColor(loadPercent, 70, 100) },
  ];
  if (storage?.pending) {
    tiles.push({ key: 'storage', icon: 'fa-hard-drive', title: 'Storage', value: '…', sub: 'Calculating…', progress: 0 });
  } else if (storage) {
    // Home (what is left of it), Notes and Downloads never overlap, so the bar is the whole home folder.
    tiles.push({ key: 'storage', icon: 'fa-hard-drive', title: 'Storage', value: storage.used,
      sub: `Home ${storage.home}\u2003Notes ${storage.notes}\u2003Downloads ${storage.downloads}`, slotHtml: storageSubHtml(storage),
      progress: 100, segments: [storage.home_percent, storage.notes_percent, storage.downloads_percent].join(','),
      segmentColors: [STORAGE_COLORS.home, STORAGE_COLORS.notes, STORAGE_COLORS.downloads].join(',') });
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

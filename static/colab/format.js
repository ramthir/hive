/** What the Colab tab shows, kept free of DOM access so it can be unit-tested. */
import { levelColor } from '../dashboard/format.js';

export const PAGE_SIZE = 10;
export const SORTS = { cpu_percent: 'cpu_percent', mem: 'mem_percent' }; // table column key -> process field

/** Green below 60%, yellow below 85%, red above. */
export const usageColor = (percent) => levelColor(percent, 60, 85);

const clamp = (n) => Math.min(100, Math.max(0, Number(n) || 0));
const has = (value) => value !== null && value !== undefined;

/** The Compute Units, Usage Rate and Active Assignments cards for `GET /api/colab/usage`; every one reads "Unable to read" when the CLI could not be reached. */
export function usageTiles(usage) {
  if (!usage || usage.reachable === false) {
    return ['balance', 'rate', 'assignments'].map((key) => ({ key, value: '-', sub: 'Unable to read', color: '' }));
  }
  const rate = has(usage.usage_rate) ? `${usage.usage_rate.toFixed(2)}${usage.usage_rate_unit || '/hr'}` : '-';
  const burning = usage.usage_rate > 0;
  const assignments = has(usage.active_assignments) ? usage.active_assignments : '-';
  return [
    { key: 'balance', value: has(usage.balance) ? usage.balance.toFixed(2) : '-', sub: 'Available compute units', color: 'var(--color-green)' },
    { key: 'rate', value: rate, sub: burning ? 'Active burn rate' : 'Idle', color: burning ? 'var(--color-yellow)' : 'var(--color-dimmed2)' },
    { key: 'assignments', value: assignments, sub: assignments === 0 ? 'No active session' : '', color: assignments > 0 ? 'var(--color-green)' : 'var(--color-dimmed2)' },
  ];
}

/** Linux prints uptime as H:MM past an hour; make the units explicit. */
export const uptimeText = (uptime) => String(uptime || '-').replace(/\b(\d+):(\d{2})\b/g, '$1h $2m');

export function uptimeTile(stats, session, selected) {
  if (!session && !selected) return { key: 'uptime', value: '-', sub: 'No active session' };
  return { key: 'uptime', value: uptimeText(stats?.uptime), sub: session ? `${session.name} · ${session.hardware}` : selected || 'Colab VM' };
}

const gb = (n) => `${Number(n).toFixed(1)} GB`;

function meter(key, icon, title, part) {
  const pct = part && has(part.percent) ? part.percent : null;
  const ok = part && has(part.used_gb) && has(part.total_gb) && pct !== null;
  return { key, icon, title, value: part && has(part.used_gb) ? gb(part.used_gb) : '-', sub: ok ? `of ${gb(part.total_gb)} (${pct}%)` : '-',
           color: pct !== null ? usageColor(pct) : '', progress: pct !== null ? clamp(pct) : 0, progressColor: pct !== null ? usageColor(pct) : '' };
}

/**
 * The machine cards for the session's stats. With a GPU the GPU card takes the load average's place, after the CPU's.
 * `session` supplies the hardware label; `stats` may be null before the first collection.
 */
export function machineTiles(stats, session) {
  const s = stats || {};
  const cpu = has(s.cpu_percent) ? s.cpu_percent : null;
  const cores = s.cpu_count ? `${s.cpu_count} vCPU${s.cpu_count === 1 ? '' : 's'}` : '';
  const hardware = session ? `${session.hardware} (${session.shape})` : '';
  const load = s.load_average || {};
  const gpus = Array.isArray(s.gpu) ? s.gpu : [];
  const tiles = {
    cpu: { key: 'cpu', icon: 'fa-microchip', title: 'CPU Usage', value: cpu !== null ? `${cpu.toFixed(1)}%` : '-', sub: [cores, hardware].filter(Boolean).join(' · ') || '-',
           color: cpu !== null ? usageColor(cpu) : '', progress: cpu !== null ? clamp(cpu) : 0, progressColor: cpu !== null ? usageColor(cpu) : '' },
    memory: meter('memory', 'fa-memory', 'Memory', s.memory),
    disk: meter('disk', 'fa-hard-drive', 'Storage (/content)', s.disk),
    load: { key: 'load', icon: 'fa-chart-line', title: 'Load Average', value: has(load['1min']) ? load['1min'].toFixed(2) : '-',
            sub: has(load['5min']) && has(load['15min']) ? `5m: ${load['5min'].toFixed(2)} / 15m: ${load['15min'].toFixed(2)}` : '5m: - / 15m: -' },
  };
  if (!gpus.length) return [tiles.cpu, tiles.memory, tiles.disk, tiles.load];
  const gpu = gpus[0];
  const util = has(gpu.utilization_percent) ? gpu.utilization_percent : null;
  const vram = has(gpu.memory_used_mb) && has(gpu.memory_total_mb) ? ` · VRAM ${(gpu.memory_used_mb / 1024).toFixed(1)}/${(gpu.memory_total_mb / 1024).toFixed(1)} GB (${gpu.memory_percent}%)` : '';
  const gpuTile = { key: 'gpu', icon: 'fa-microchip', title: 'GPU Usage', value: util !== null ? `${util}%` : '-', sub: `${gpu.name || 'GPU'}${vram}`,
                    color: util !== null ? usageColor(util) : '', progress: util !== null ? clamp(util) : 0, progressColor: util !== null ? usageColor(util) : '' };
  return [tiles.cpu, gpuTile, tiles.memory, tiles.disk];
}

/**
 * What a stream event says to the person: `error` when collection failed (red), otherwise a `notice` such as "monitoring is paused", each with
 * when the data is from if it is not live. A `loading` event says nothing.
 */
export function statusText(data, now = new Date()) {
  if (!data || data.status === 'loading') return { notice: '', error: '' };
  const stale = data.status !== 'ready' && data.last_updated ? ` Last updated ${new Date(data.last_updated).toLocaleTimeString([], { hour12: false })}.` : '';
  if (data.status === 'unavailable') return { notice: '', error: `${data.message || 'Unable to collect Colab status.'}${stale}` };
  const text = `${data.message || ''}${stale}`.trim();
  return { notice: text, error: '' };
}

/** One page of the processes, sorted here (the stream sends at most 100): highest first by default, and always the lower pid first on a tie. */
export function processPage(processes, { sort = 'cpu_percent', dir = 'desc', page = 0, pageSize = PAGE_SIZE } = {}) {
  const field = SORTS[sort] || sort;
  const factor = dir === 'asc' ? 1 : -1;
  const sorted = [...(processes || [])].sort((a, b) => factor * ((Number(a[field]) || 0) - (Number(b[field]) || 0)) || (Number(a.pid) || 0) - (Number(b.pid) || 0));
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(Math.max(0, page), totalPages - 1);
  return { items: sorted.slice(current * pageSize, (current + 1) * pageSize), total: sorted.length, totalPages, page: current, pageSize };
}

/** The runtimes in the session picker: which is selected, and what each row shows. */
export function pickerItems(sessions, selected) {
  return (sessions || []).map((s) => ({ name: s.name, runtime: s.runtime_id, variant: s.variant, active: s.name === selected }));
}

/** The session to show: the one chosen if it is still active, else the first. */
export const chooseSession = (sessions, selected) => (sessions || []).find((s) => s.name === selected)?.name ?? sessions?.[0]?.name ?? null;

const EVENT_SOURCE_CLOSED = 2; // EventSource.CLOSED: the browser gave up (a non-200 answer, such as 409 while the CLI failed) and will not reconnect

/** Whether the stream for `session` is already live. A closed source is not: it has to be opened again. */
export const streamIsLive = (source, streamed, session) => Boolean(source) && streamed === session && source.readyState !== EVENT_SOURCE_CLOSED;

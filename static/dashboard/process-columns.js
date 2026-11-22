/** The process table's columns, shared by the Debian and Colab tabs (DOM-free, so it can be unit-tested). */
import { escapeHtml as esc } from '../html.js';
import { processColor, processTitle, statusColor } from './format.js';

const percent = (value) => `<span style="color:${processColor(value)}">${(Number(value) || 0).toFixed(1)}%</span>`;

/** `threads` and `status` add the Debian tab's two extra columns; `mem` sorts on `mem_percent` and shows the size. */
export function processColumns({ threads = false, status = false } = {}) {
  return [
    { key: 'name', label: 'Process', className: 'proc-cell',
      render: (_v, p) => `<span class="proc-label" title="${esc(processTitle(p))}"><span class="proc-name">${esc(p.name)}</span>${p.project ? `<span class="proc-project">(${esc(p.project)})</span>` : ''}${p.cmdline ? `<span class="proc-cmd">${esc(p.cmdline)}</span>` : ''}</span>` },
    { key: 'pid', label: 'PID', className: 'muted tabular', width: '5.5rem', render: (v) => esc(v) },
    ...(threads ? [{ key: 'threads', label: 'Threads', className: 'muted tabular', width: '6rem', render: (v) => esc(v) }] : []),
    ...(status ? [{ key: 'status', label: 'Status', className: 'tabular', width: '7rem', render: (v) => `<span style="color:${statusColor(v)}">${esc(v || '--')}</span>` }] : []),
    { key: 'running_for', label: 'Running', className: 'tabular', width: '7rem', render: (v) => `<span class="muted">${esc(v || '--')}</span>` },
    { key: 'cpu_percent', label: 'CPU', className: 'tabular', width: '6rem', sortable: true, render: percent },
    { key: 'mem', label: 'Memory', className: 'tabular', width: '7.5rem', sortable: true,
      render: (v, row) => `<span title="${(Number(row.mem_percent) || 0).toFixed(1)}%">${esc(v || '—')}</span>` },
  ];
}

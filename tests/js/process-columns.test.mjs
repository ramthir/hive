import assert from 'node:assert/strict';
import test from 'node:test';
import { processColumns } from '../../static/dashboard/process-columns.js';

const proc = { name: '<python>', cmdline: 'train.py "x"', pid: 7, threads: 3, status: 'running', running_for: '1h 5m', cpu_percent: 85.04, mem_percent: 12.3, mem: '1.2 GB' };
const cell = (columns, key, row = proc) => { const column = columns.find((c) => c.key === key); return column.render(row[key], row); };

test('the Colab tab and the Debian tab share one set of columns, Debian adding Threads and Status', () => {
  assert.deepEqual(processColumns().map((c) => c.key), ['name', 'pid', 'running_for', 'cpu_percent', 'mem']);
  assert.deepEqual(processColumns({ threads: true, status: true }).map((c) => c.key), ['name', 'pid', 'threads', 'status', 'running_for', 'cpu_percent', 'mem']);
  assert.deepEqual(processColumns().filter((c) => c.sortable).map((c) => c.key), ['cpu_percent', 'mem']);
});

test('a process is drawn with its name escaped, its percentage coloured and its memory titled with the share', () => {
  const columns = processColumns({ threads: true, status: true });
  assert.match(cell(columns, 'name'), /&lt;python&gt;/);
  assert.equal(cell(columns, 'name').includes('<python>'), false);
  assert.match(cell(columns, 'cpu_percent'), /color:var\(--color-red\)">85\.0%</);
  assert.match(cell(columns, 'status'), /color:var\(--color-green\)">running</);
  assert.match(cell(columns, 'mem'), /title="12\.3%">1\.2 GB</);
  assert.match(cell(columns, 'running_for'), /muted">1h 5m</);
  assert.match(cell(columns, 'running_for', { running_for: '' }), />--</);
});

/** The three stat cards above the time table, built from the server's month summary. */
import { formatDuration } from './format.js';

export const TOTAL_TARGET_MINUTES = 160 * 60;
export const DAILY_TARGET_MINUTES = 8 * 60;
const COLORS = { total: 'var(--color-accent6)', tasks: 'var(--color-accent4)', meetings: 'var(--color-accent5)' };

/**
 * The three stat cards above the table (Pandora's: Total Logged with the month's sparkline and the day's and
 * month's progress, Task Work, Meetings), as props for `renderStatCard`. The month, today and the per-day
 * breakdown come from the server (`month`, `today_minutes`, `days`), so no date maths is done here. The sparkline is
 * `{values, start, details}` with one entry per day of the month; `details` is null on a day without time.
 */
export function summaryTiles(meta = {}) {
  const total = Number(meta.total_minutes) || 0;
  const share = (minutes) => (total ? Math.round(((Number(minutes) || 0) / total) * 100) : 0);
  const count = Number(meta.total_entries) || 0;
  const todayMinutes = Number(meta.today_minutes) || 0;
  const percent = (minutes, target) => Math.min(100, Math.round((minutes / target) * 100));
  const tiles = [
    {
      key: 'total', icon: 'fa-clock', title: 'Total Logged', value: formatDuration(total), sub: `${count} ${count === 1 ? 'entry' : 'entries'}`,
      color: COLORS.total, progress: percent(total, TOTAL_TARGET_MINUTES), dailyProgress: percent(todayMinutes, DAILY_TARGET_MINUTES),
      dailyTooltipTitle: "Today's progress", dailyTooltip: `${formatDuration(todayMinutes)} of ${DAILY_TARGET_MINUTES / 60}h logged today`,
    },
    { key: 'tasks', icon: 'fa-list-check', title: 'Task Work', value: formatDuration(meta.task_minutes), sub: `${share(meta.task_minutes)}% of logged time`, color: COLORS.tasks },
    { key: 'meetings', icon: 'fa-calendar-check', title: 'Meetings', value: formatDuration(meta.meeting_minutes), sub: `${share(meta.meeting_minutes)}% of logged time`, color: COLORS.meetings },
  ];
  const spark = monthSparkline(meta);
  if (spark) tiles[0].sparkline = spark;
  return tiles;
}

/** One value per day of the server's month, and for each day with time the rows the sparkline's tooltip lists. */
export function monthSparkline(meta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(meta?.month ?? ''));
  if (!m) return null;
  const length = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  const byDay = new Map((meta.days || []).map((d) => [d.day, d]));
  const dayKey = (n) => `${m[1]}-${m[2]}-${String(n).padStart(2, '0')}`;
  const days = Array.from({ length }, (_, i) => byDay.get(dayKey(i + 1)));
  return {
    start: dayKey(1),
    values: days.map((d) => d?.minutes ?? 0),
    details: days.map((d) => (d ? [
      ...d.items.map((i) => ({ label: i.title, value: formatDuration(i.minutes), ...(i.project ? { note: `(${i.project})` } : {}) })),
      { label: 'Total', value: formatDuration(d.minutes) },
    ] : null)),
  };
}

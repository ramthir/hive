/** Formatting shared by the time page and the note page: durations, days, today. */
export const MAX_MINUTES = 1440;

export { formatDuration } from '../duration.js';

export const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));

/** `Fri, Nov 20, 2026` for an ISO day, read as a calendar day (no time zone shift). */
export function formatDay(day) {
  if (!isDay(day)) return String(day ?? '');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Today as an ISO day in the browser's time zone. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

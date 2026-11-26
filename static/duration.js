/** How every page writes a length of time in minutes: time logged, quota resets, episode lengths, sparkline days. */
/** 90 -> "1h 30m", 45 -> "45m", 120 -> "2h". */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

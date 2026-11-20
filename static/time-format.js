/** Parse a server timestamp. One without a timezone is UTC. */
export function parseUtcDate(dateString) {
  if (!dateString) return null;
  const str = String(dateString).trim();
  const hasTimezone = str.endsWith('Z') || /[+-]\d{2}(?::?\d{2})?$/.test(str);
  const normalized = hasTimezone ? str : `${str.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date(dateString) : date;
}

/** "Just now", "5m ago", "3h ago", "Yesterday", "4d ago", then "Oct 9". */
export function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = parseUtcDate(dateString);
  if (!date) return '';
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "—" for no date, the original text for an unreadable one, otherwise "Oct 9, 2026, 2:05 PM". */
export function formatFullDateTime(dateString) {
  if (!dateString) return '—';
  const date = parseUtcDate(dateString);
  if (!date || Number.isNaN(date.getTime())) return String(dateString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

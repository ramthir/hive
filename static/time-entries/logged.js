/** What the note page shows about a note's logged time. */
import { formatDay, formatDuration } from './format.js';

/** A note takes logged time when it has a file and the server says it is a task or meeting (`takes_time`). */
export const canLogTime = (note) => Boolean(note?.slug) && note.takes_time === true;

/** Minutes logged over all days of a note's `time` map. */
export const loggedMinutes = (time) => Object.values(time || {}).reduce((sum, m) => sum + (Number(m) || 0), 0);

/** "3h 30m logged" for the note's footer; '' when nothing is logged. */
export const loggedLabel = (time) => {
  const total = loggedMinutes(time);
  return total ? `${formatDuration(total)} logged` : '';
};

/** What the Log time dialog says about the chosen day: what is there already, or that it starts the day. */
export function dayHint(time, day) {
  const minutes = Number(time?.[day]) || 0;
  return minutes ? `${formatDuration(minutes)} already logged on ${formatDay(day)}. This adds to it.` : `Nothing logged on ${formatDay(day)} yet.`;
}

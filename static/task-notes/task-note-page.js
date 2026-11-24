import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { defineReadPage } from '/static/notes/read-page.js';
import { showToast } from '/static/toast.js';
import { openLogTime, updateLogged } from '/static/notes/log-time.js';
import { formatDay, formatDuration } from '/static/time-entries/format.js';
import { TaskView } from '/static/task-notes/task-view.js';

/* /tasks/{slug}: a note of type task as a header of chips, a progress count and a card per section (page logic in static/notes/read-page.js). */

// Logging time commits only the note's `time` key; the page keeps its text and redraws only the footer chip.
function logTime(app) {
  const note = app.note;
  if (!note) return;
  const applied = (fresh) => {
    if (app.note?.slug !== note.slug) return false;
    app.note = { ...app.note, time: fresh.time, updated: fresh.updated, revision: fresh.revision };
    updateUpdatedStamp(app, app.note);
    updateLogged(app, app.note);
    return true;
  };
  openLogTime(note, {
    onLogged: (fresh, minutes) => { if (applied(fresh)) showToast(`Logged ${formatDuration(minutes)} · ${note.title}`, 'success'); },
    onRemoved: (fresh, day) => { if (applied(fresh)) showToast(`Removed ${formatDay(day)} · ${note.title}`, 'success'); },
  });
}

defineReadPage({
  tag: 'task-note-app',
  type: 'task',
  View: TaskView,
  viewOptions: (app) => ({ logTime: () => logTime(app) }),
  onSaved: (app, saved) => app.draw(saved), // status, priority, project and tags are in the header: draw it again
});

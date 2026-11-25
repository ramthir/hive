import { defineReadPage } from '/static/notes/read-page.js';
import { logReadPageTime } from '/static/notes/log-time.js';
import { TaskView } from '/static/task-notes/task-view.js';

/* /tasks/{slug}: a note of type task as a header of chips, a progress count and a card per section (page logic in static/notes/read-page.js). */

defineReadPage({
  tag: 'task-note-app',
  type: 'task',
  View: TaskView,
  viewOptions: (app) => ({ logTime: () => logReadPageTime(app) }),
  onSaved: (app, saved) => app.draw(saved), // status, priority, project and tags are in the header: draw it again
});

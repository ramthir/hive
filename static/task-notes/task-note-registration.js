import { logReadPageTime } from '/static/notes/log-time.js';
import { TaskView } from '/static/task-notes/task-view.js';

export default {
  View: TaskView,
  viewOptions: (app) => ({ logTime: () => logReadPageTime(app) }),
  onSaved: (app, saved) => app.draw(saved), // status, priority, project and tags are in the header: draw it again
};

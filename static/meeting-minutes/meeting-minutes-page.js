import { defineReadPage } from '/static/notes/read-page.js';
import { logReadPageTime } from '/static/notes/log-time.js';
import { MeetingMinutesView } from '/static/meeting-minutes/meeting-minutes-view.js';

defineReadPage({
  tag: 'meeting-minutes-app',
  type: window.location.pathname.startsWith('/meetings/') ? 'meeting' : 'meeting_minutes',
  View: MeetingMinutesView,
  viewOptions: (app) => ({ logTime: () => logReadPageTime(app) }),
  onSaved: (app, saved) => app.draw(saved),
});

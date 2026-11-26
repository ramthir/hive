import { logReadPageTime } from '/static/notes/log-time.js';
import { MeetingMinutesView } from '/static/meeting-minutes/meeting-minutes-view.js';

export default {
  View: MeetingMinutesView,
  viewOptions: (app) => ({
    logTime: () => logReadPageTime(app),
    saved: (note) => app.draw(note),
    reload: () => app.load(),
  }),
  onSaved: (app, saved) => app.draw(saved),
};

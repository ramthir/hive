import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { TimelineView } from '/static/timelines/timeline-view.js';

export default {
  View: TimelineView,
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
};

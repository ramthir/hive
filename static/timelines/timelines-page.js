import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { defineReadPage } from '/static/notes/read-page.js';
import { TimelineView } from '/static/timelines/timeline-view.js';

/* /timelines/{slug}: a note of type timeline as phases (page logic in static/notes/read-page.js). */

defineReadPage({
  tag: 'timelines-app',
  type: 'timeline',
  View: TimelineView,
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
});

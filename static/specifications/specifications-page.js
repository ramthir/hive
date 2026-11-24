import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { defineReadPage } from '/static/notes/read-page.js';
import { SpecificationView } from '/static/specifications/specification-view.js';

/* /specifications/{slug}: a note of type specification as an objective and requirement cards (page logic in static/notes/read-page.js). */

defineReadPage({
  tag: 'specifications-app',
  type: 'specification',
  View: SpecificationView,
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
});

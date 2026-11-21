import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { defineReadPage } from '/static/notes/read-page.js';
import { TableView } from '/static/tables/table-view.js';

/* /tables/{slug}: a note of type table as a table (page logic in static/notes/read-page.js). */

defineReadPage({
  tag: 'tables-app',
  type: 'table',
  View: TableView,
  viewOptions: (app) => ({
    go: (path) => window.location.assign(path),
    saved: (saved) => {
      app.note = saved;
      updateUpdatedStamp(app, saved);
    },
  }),
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
});

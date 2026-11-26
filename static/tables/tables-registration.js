import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { TableView } from '/static/tables/table-view.js';

export default {
  View: TableView,
  viewOptions: (app) => ({
    go: (path) => window.location.assign(path),
    saved: (saved) => {
      app.note = saved;
      updateUpdatedStamp(app, saved);
    },
  }),
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
};

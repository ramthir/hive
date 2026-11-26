import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { SpecificationView } from '/static/specifications/specification-view.js';

export default {
  View: SpecificationView,
  onSaved: (app, saved) => updateUpdatedStamp(app, saved),
};

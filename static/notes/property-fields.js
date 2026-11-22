// The properties drawer without the DOM: which fields show, what to send, and the markup of the fields.
import { escapeHtml as esc } from '../html.js';

/** A field with a `show_when` (Acting for) is only shown while the field it names has that value. */
export const isVisible = (field, values) => !field.show_when || (values[field.show_when.key] ?? '') === field.show_when.value;

const clean = (value) => String(value ?? '').split(/\s+/).filter(Boolean).join(' '); // as the server reads it
const tagList = (value) => [...new Set(String(value ?? '').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];

/**
 * The body of the `PUT /notes/{slug}` that saves the drawer: only what changed. `status`, `priority` and `week` are
 * top-level keys of the update (so is `tags`; changed tags travel with the priority, because the server
 * drops a priority tag from the tags it is given), every other field goes in `properties`. A field that is hidden is not sent: the server
 * drops it itself once the field it depends on changes. Returns null when nothing changed.
 */
export function propertyChanges(fields, values) {
  const body = {};
  for (const field of fields) {
    const tags = field.target === 'tags';
    const norm = (v) => (tags || field.multiple ? tagList(v).join(',') : clean(v)); // a list of titles is compared as the server keeps it
    const value = norm(values[field.key]);
    if (!isVisible(field, values) || value === norm(field.value)) continue;
    if (tags) body.tags = tagList(value);
    else if (field.target === 'property') (body.properties ||= {})[field.key] = value;
    else body[field.target] = value;
  }
  const priority = fields.find((f) => f.target === 'priority');
  if (body.tags && priority && !('priority' in body)) body.priority = clean(values[priority.key] ?? priority.value);
  return Object.keys(body).length ? body : null;
}

/**
 * The first required field the save would leave empty, as the server checks it: visible, required, empty, and either
 * changed itself or shown by a field that changed. Null when all is well.
 */
export function missingRequired(fields, values) {
  const was = Object.fromEntries(fields.map((f) => [f.key, clean(f.value)]));
  return fields.find((field) => field.required && isVisible(field, values) && !clean(values[field.key])
    && (clean(values[field.key]) !== was[field.key] || (field.show_when && clean(values[field.show_when.key]) !== was[field.show_when.key]))) || null;
}

const control = (field) => {
  const label = esc(field.label);
  if (field.kind === 'tags') {
    return `<app-combobox data-key="${esc(field.key)}" multiple creatable aria-label="${label}" placeholder="${esc(field.placeholder)}" value="${esc(field.value)}"></app-combobox>`;
  }
  if (field.kind === 'text') {
    return `<input data-key="${esc(field.key)}" aria-label="${label}" maxlength="255" placeholder="${esc(field.placeholder)}" value="${esc(field.value)}">`;
  }
  const many = field.multiple ? ` multiple${field.kind === 'values' ? ' creatable' : ''}` : '';
  const options = field.choices.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
  return `<app-combobox data-key="${esc(field.key)}"${many} aria-label="${label}" placeholder="${esc(field.placeholder)}" value="${esc(field.value)}">${options}</app-combobox>`;
};

/** The drawer's fields as HTML, with a heading wherever the group changes. */
export function renderFields(form) {
  let previous;
  return form.fields.map((field) => {
    const heading = field.group !== previous && form.groups[field.group]
      ? `<div class="property-group-header"><span class="property-group-title">${esc(form.groups[field.group])}</span></div>` : '';
    previous = field.group;
    return `${heading}<label class="field${field.wide ? ' field-full-width' : ''}" data-field="${esc(field.key)}"${field.show_when ? ' hidden' : ''}>
      <span class="property-label"><i class="fa-solid fa-${esc(field.icon)}" aria-hidden="true"></i> ${esc(field.label)}</span>${control(field)}</label>`;
  }).join('');
}

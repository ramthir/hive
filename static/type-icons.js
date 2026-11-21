// One icon per note type, shared by the action bar and the spotlight. Names are Font Awesome (free, solid).
// The first block is Pandora's own set; the second covers the types used in the notes vault.
export const TYPE_ICONS = {
  // Pandora's types
  project: 'hammer',
  task: 'list-check',
  status: 'circle-check',
  priority: 'flag',
  company: 'building',
  contact: 'user',
  role: 'id-badge',
  technology: 'microchip',
  city: 'city',
  education: 'graduation-cap',
  application: 'code',
  team: 'users',
  folder: 'folder',
  document: 'file-lines',
  table: 'table',
  diagram: 'diagram-project',
  runbook: 'book-open',
  prompt: 'wand-magic-sparkles',
  work_nature: 'screwdriver-wrench',
  domain: 'globe',
  component: 'sitemap',
  specification: 'certificate',
  decision: 'share-nodes',
  environment: 'layer-group',
  month: 'calendar-days',
  year: 'calendar',
  week: 'calendar-week',
  meeting: 'calendar-check',
  meeting_minutes: 'file-pen',
  resource: 'hard-drive',
  // Types used in the vault
  note: 'note-sticky',
  clipping: 'newspaper',
  holiday: 'umbrella-beach',
  spec: 'certificate',
  product: 'box',
  timeline: 'timeline',
  glossary: 'spell-check',
  book: 'book',
  reference: 'bookmark',
  keynote: 'person-chalkboard',
  hub: 'circle-nodes',
  guideline: 'clipboard-list',
  interview: 'comments',
};

// Icon colour per type: a palette token (tokens.css, --color-<name>). Where Pandora colours a type (document, table,
// diagram, contact, project, spec, minutes, month, week) the colour is the same; the rest follow the same groups.
// A type that is not listed keeps the muted default.
export const TYPE_COLORS = {
  document: 'purple', clipping: 'purple', reference: 'purple', book: 'purple', glossary: 'purple', week: 'purple',
  project: 'blue', specification: 'blue', spec: 'blue', product: 'blue', component: 'blue', application: 'blue', month: 'blue', year: 'blue', timeline: 'blue',
  table: 'green', contact: 'green', team: 'green', role: 'green', company: 'green', education: 'green',
  task: 'orange', status: 'orange', priority: 'orange', prompt: 'orange', runbook: 'orange', guideline: 'orange', decision: 'orange',
  note: 'yellow', meeting: 'blue', meeting_minutes: 'yellow', interview: 'yellow', holiday: 'yellow', keynote: 'yellow',
  diagram: 'red', hub: 'red', environment: 'red', resource: 'red', domain: 'red', technology: 'red', city: 'red', folder: 'red', work_nature: 'red',
};

export const DEFAULT_TYPE = 'note';
export const FALLBACK_ICON = 'file-lines';

// "Meeting Minutes", "meeting-minutes" and "meeting_minutes" are the same type.
const normalize = (type) => String(type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Icon for one type; an unknown type gets a plain file icon. */
export const typeIcon = (type) => TYPE_ICONS[normalize(type)] || FALLBACK_ICON;

/** Icon for a note: that of its first type, or of the default type when it has none. */
export const noteTypeIcon = (types) => typeIcon((types || []).find((t) => normalize(t)) ?? DEFAULT_TYPE);

/** CSS colour of one type's icon, or '' (the muted default) for a type without one. */
export const typeColor = (type) => (TYPE_COLORS[normalize(type)] ? `var(--color-${TYPE_COLORS[normalize(type)]})` : '');

/** Icon colour for a note: that of its first type, or of the default type when it has none. */
export const noteTypeColor = (types) => typeColor((types || []).find((t) => normalize(t)) ?? DEFAULT_TYPE);

/** `meeting_minutes` -> `Meeting Minutes`: how a type is shown; the stored value stays as typed. */
export const typeLabel = (type) => String(type).trim().split(/[\s_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Choices of the type combobox: the known types, the types used in the vault and the note's own, by name, each with its icon and a title case label. */
export function typeOptions(vaultTypes = [], current = []) {
  const names = new Set([...Object.keys(TYPE_ICONS), ...(vaultTypes || []), ...(current || [])].map((t) => String(t).trim()).filter(Boolean));
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: typeLabel(name), icon: `fa-solid fa-${typeIcon(name)}` }));
}

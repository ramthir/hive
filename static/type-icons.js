// One icon per note type, shared by the action bar and the spotlight. Names are Font Awesome (free, solid).
// The first block is Pandora's own set; the second covers the types used in the notes vault.
export const TYPE_ICONS = {
  // Pandora's types
  project: 'briefcase',
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

export const DEFAULT_TYPE = 'note';
export const FALLBACK_ICON = 'file-lines';

// "Meeting Minutes", "meeting-minutes" and "meeting_minutes" are the same type.
const normalize = (type) => String(type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Icon for one type; an unknown type gets a plain file icon. */
export const typeIcon = (type) => TYPE_ICONS[normalize(type)] || FALLBACK_ICON;

/** Icon for a note: that of its first type, or of the default type when it has none. */
export const noteTypeIcon = (types) => typeIcon((types || []).find((t) => normalize(t)) ?? DEFAULT_TYPE);

/** `meeting_minutes` -> `Meeting Minutes`: how a type is shown; the stored value stays as typed. */
export const typeLabel = (type) => String(type).trim().split(/[\s_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Choices of the type combobox: the known types, the types used in the vault and the note's own, by name, each with its icon and a title case label. */
export function typeOptions(vaultTypes = [], current = []) {
  const names = new Set([...Object.keys(TYPE_ICONS), ...(vaultTypes || []), ...(current || [])].map((t) => String(t).trim()).filter(Boolean));
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: typeLabel(name), icon: `fa-solid fa-${typeIcon(name)}` }));
}

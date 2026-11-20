// Tag suggestions for the footer's tag field. DOM-free, so it is unit tested.

/** The tags in use (`GET /api/tags`, name -> notes) and the note's own, by name ignoring case, each with its count. */
export function tagOptions(counts = {}, current = []) {
  const names = new Set([...Object.keys(counts || {}), ...(current || [])].map((t) => String(t).trim()).filter(Boolean));
  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
    .map((name) => ({ value: name, label: name, ...(counts?.[name] ? { meta: String(counts[name]) } : {}) }));
}

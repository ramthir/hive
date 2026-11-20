/** Escape text for use in HTML content and quoted attribute values. */
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]
  );

const DEFAULT_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/**
 * Make a URL taken from data safe to place in an href attribute. Returns it escaped for the
 * attribute, or '#' when it names a scheme outside `protocols` (javascript:, data:, vbscript:…).
 * A URL with no scheme is relative and passes. Whitespace and control characters are ignored
 * when reading the scheme, since browsers ignore them too ("java\tscript:").
 */
export const safeHref = (url, protocols = DEFAULT_LINK_PROTOCOLS) => {
  const text = String(url ?? '').trim();
  const scheme = text.replace(/[\u0000- \u007f]/g, '').match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !protocols.includes(`${scheme[1].toLowerCase()}:`)) return '#';
  return escapeHtml(text);
};

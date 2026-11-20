import { escapeHtml as esc } from '/static/html.js';

/* Markdown for the notes preview: [[wikilinks]] on top of marked, and a sanitising render. */

let _markedWikilinkConfigured = false;

// A table row is split on every unescaped "|" before inline parsing, so the alias
// separator in [[target|label]] must be escaped inside table rows to stay one cell.
export function escapeWikilinkPipesInTableRows(markdown) {
  let fence = null;
  return String(markdown).split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (marker) {
      fence = marker[1];
      return line;
    }
    if (!/^\s*\|/.test(line)) return line;
    return line.replace(/\[\[[^\]\r\n]*\]\]/g, (link) => link.replace(/(?<!\\)\|/g, '\\|'));
  }).join('\n');
}

export function configureMarkedWikilinks(markedLib) {
  const markedInstance = markedLib || globalThis.marked;
  if (_markedWikilinkConfigured || !markedInstance?.use) return;
  markedInstance.use({
    hooks: { preprocess: escapeWikilinkPipesInTableRows },
    renderer: {
      tablecell(content, flags) {
        const type = flags.header ? 'th' : 'td';
        const tag = flags.align ? `<${type} align="${flags.align}" style="text-align: ${flags.align}">` : `<${type}>`;
        return `${tag}${content}</${type}>\n`;
      },
    },
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src) => src.indexOf('[['),
        tokenizer(src) {
          const match = /^\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/.exec(src);
          if (!match) return undefined;
          const target = match[1].trim();
          if (!target) return undefined;
          const label = (match[2] !== undefined ? match[2] : match[1]).trim();
          return { type: 'wikilink', raw: match[0], target, text: label || target, autoLabel: match[2] === undefined };
        },
        // Resolved against the notes on disk after rendering (see decorateWikilinks).
        renderer: (token) => `<a class="notes-wikilink" data-target="${esc(token.target)}"${token.autoLabel ? ' data-auto-label="true"' : ''} href="#">${esc(token.text)}</a>`,
      },
    ],
  });
  _markedWikilinkConfigured = true;
}

/**
 * Render markdown to a sanitised HTML string.
 * `isRoute(pathname)` says whether a same-origin link is an in-app route (it gets `data-route`);
 * `decorate(doc)` may rewrite the parsed document last (diagram figures).
 */
export function renderMarkdownPreview(content, { isRoute = () => false, decorate = null } = {}) {
  const markdownText = String(content || '');
  const markedLib = globalThis.marked;
  if (!markedLib?.parse) return `<pre>${esc(markdownText)}</pre>`;
  configureMarkedWikilinks(markedLib);
  globalThis.PandoraMath?.configure(markedLib, globalThis.katex);

  const parsed = new DOMParser().parseFromString(markedLib.parse(markdownText, { gfm: true, breaks: false }), 'text/html');
  // Mark task items so they can be styled whether marked renders them tight (`li > input`) or loose
  // (`li > p > input`), and let a hard-wrapped item flow as one text: `breaks: true` would force a <br>.
  parsed.querySelectorAll('li > input[type="checkbox"], li > p > input[type="checkbox"]').forEach((checkbox) => {
    const item = checkbox.closest('li');
    item.classList.add('notes-task-item');
    if (checkbox.checked) item.classList.add('notes-task-item--done');
    item.querySelectorAll(':scope > br, :scope > p > br').forEach((lineBreak) => lineBreak.replaceWith(' '));
  });
  parsed.querySelectorAll('script, style, iframe, object, embed, form').forEach((element) => element.remove());
  parsed.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    });
    for (const attributeName of ['href', 'src']) {
      const attribute = element.getAttribute(attributeName);
      if (!attribute) continue;
      try {
        if (element.classList.contains('notes-wikilink') && attributeName === 'href') continue;
        const url = new URL(attribute, window.location.href);
        if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) element.removeAttribute(attributeName);
        else if (attributeName === 'href') {
          if (url.origin === window.location.origin) {
            element.removeAttribute('target');
            if (!attribute.startsWith('#') && isRoute(url.pathname)) element.setAttribute('data-route', '');
          } else {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
          }
        }
      } catch (_error) {
        element.removeAttribute(attributeName);
      }
    }
  });
  globalThis.hljs?.highlightElement && parsed.querySelectorAll('pre code').forEach((block) => {
    try { globalThis.hljs.highlightElement(block); } catch (_error) { /* unknown language */ }
  });
  if (decorate) decorate(parsed);
  return parsed.body.innerHTML;
}

import '/static/components/dropdown-menu.js'; // the menu on a rendered diagram (Download PNG)
import { escapeHtml as esc } from '/static/html.js';
import { showToast } from '/static/toast.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { api } from '/static/notes/api.js';
import { setupCodeBlockActions } from '/static/notes/code-blocks.js';
import { DiagramPreviews, embedFileName, embedPngUrl } from '/static/notes/diagrams.js';
import { renderMarkdownPreview } from '/static/notes/markdown.js';
import { renderReadActionBar, wireReadActionBar } from '/static/notes/status-bar.js';
import { decorateWikilinks, handleWikilinkClick, promptCreateNote } from '/static/notes/wikilinks.js';

/** Save a high-resolution PNG of one diagram (300 dpi where it fits; the server picks the dpi). */
export function downloadDiagramPng(note, source, theme) {
  return savePng(() => fetch('/api/diagram/render/png', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, theme }),
  }), note?.title, theme);
}

/** The same for an embedded diagram (`/notes/<slug>/diagram.svg?n=2`): the server renders the other note's diagram as PNG. */
export function downloadEmbedPng(src, alt, theme) {
  return savePng(() => fetch(embedPngUrl(src, theme)), embedFileName(src, alt), theme);
}

/** Run the diagram menu's choice for the figure the event came from: a fenced diagram (`data-diagram`) or an embed (`data-embed`). */
export function handleDiagramMenu(event, note) {
  const figure = event.target.closest?.('.notes-diagram');
  const theme = event.detail?.action;
  if (!figure || (theme !== 'dark' && theme !== 'light')) return;
  if (figure.dataset.diagram) downloadDiagramPng(note, figure.dataset.diagram, theme);
  else if (figure.dataset.embed) downloadEmbedPng(figure.dataset.embed, figure.querySelector('img')?.getAttribute('alt'), theme);
}

async function savePng(request, title, theme) {
  try {
    const res = await request();
    if (!res.ok) {
      const detail = await res.json().then((body) => body.detail).catch(() => '');
      throw new Error(detail || 'Could not render the PNG.');
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    const name = String(title || 'diagram').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'diagram';
    link.href = url;
    link.download = `${name}-${theme}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error.message || 'Could not download the diagram PNG.', 'error');
  }
}

/** Shared outer page shell (`<section class="notes-page ...">`, `<app-header>`, `<app-action-bar>`) for dedicated read pages. */
export function renderReadPageShell({
  pageClass = '',
  title,
  headerAttrs = '',
  chips = '',
  headerActions = renderSearchTrigger(),
  bodyHtml,
  note,
  typeLabel,
  typeIconName,
  actions,
  statsHtml = '',
}) {
  return `
    <section class="notes-page${pageClass ? ` ${pageClass}` : ''}">
      <app-header heading="${esc(title)}" variant="flush" attached${headerAttrs ? ` ${headerAttrs}` : ''}>
        ${chips}
        <div slot="actions" class="notes-header-actions app-header-action-group">${headerActions}</div>
      </app-header>
      ${bodyHtml}
      ${renderReadActionBar(note, { typeLabel, typeIconName, actions, statsHtml })}
    </section>`;
}

export function wireReadPageShell(host, actions, { searchTrigger = true } = {}) {
  if (searchTrigger) wireSearchTrigger(host);
  wireReadActionBar(host, actions);
}

export function renderOutlineEntry({ id, label, count }) {
  const anchor = esc(id);
  return `<a href="#${anchor}" data-spec-link="${anchor}"><span>${esc(label)}</span>${count ? ` <span class="spec-count">${esc(String(count))}</span>` : ''}</a>`;
}

/** Shared sticky outline navigation for sectioned read pages. */
export function renderOutline(entries, { ariaLabel = 'Sections', extraHtml = '' } = {}) {
  return `<nav class="spec-outline" aria-label="${esc(ariaLabel)}">
    <b>Sections</b>
    ${entries.map(renderOutlineEntry).join('')}
    ${extraHtml}
  </nav>`;
}

/**
 * Composable helper for read views that render markdown with PlantUML diagrams, wiki links, code block actions,
 * and a sticky section outline.
 */
export class ReadMarkdownSurface {
  constructor() {
    this.note = null;
    this.diagrams = new DiagramPreviews(
      (source) => api('/diagram/render', { method: 'POST', body: { source } }),
      async (slug) => (await api(`/notes/${encodeURIComponent(slug)}`)).revision,
    );
    this._onMenu = (event) => handleDiagramMenu(event, this.note);
    this._onClick = (event) => handleWikilinkClick(event, {
      onNavigate: (url) => window.location.assign(url),
      onCreate: (target) => promptCreateNote(target, {
        onCreated: (created) => window.location.assign(`/notes/${encodeURIComponent(created.slug)}?mode=edit`),
      }),
    });
  }

  markdown(text) {
    return renderMarkdownPreview(text, {
      isRoute: () => false,
      decorate: (parsed) => { this.diagrams.markBlocks(parsed); this.diagrams.markEmbeds(parsed); },
    });
  }

  decorate(root, note) {
    if (!root) return;
    this.note = note;
    decorateWikilinks(root);
    this.diagrams.decorate(root, { editing: false });
    this.diagrams.loadEmbeds(root);
    setupCodeBlockActions(root);
    root.removeEventListener('dropdown-select', this._onMenu);
    root.addEventListener('dropdown-select', this._onMenu);
    root.removeEventListener('click', this._onClick);
    root.addEventListener('click', this._onClick);
  }

  wireOutline(host) {
    this._observer?.disconnect();
    const links = new Map([...host.querySelectorAll('[data-spec-link]')].map((link) => [link.dataset.specLink, link]));
    if (typeof IntersectionObserver === 'undefined' || !links.size) return;
    this._observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach((link) => link.classList.remove('on'));
      links.get(visible.target.id)?.classList.add('on');
    }, { rootMargin: '0px 0px -70% 0px' });
    for (const id of links.keys()) {
      const target = host.querySelector(`#${CSS.escape(id)}`);
      if (target) this._observer.observe(target);
    }
  }

  destroy() {
    this._observer?.disconnect();
    this.diagrams.dispose();
  }
}

import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { renderMarkdownPreview as renderMarkdown } from '/static/notes/markdown.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';
import { setupCodeBlockActions } from '/static/notes/code-blocks.js';
import { notesRouter } from '/static/notes/notes-router.js';

export class Preview {
  getTitleFromContent(content) {
    const heading = /^#\s+(.+)$/m.exec(String(content || ''));
    return heading ? heading[1].trim() : '';
  }

  // Save a high-resolution PNG of one diagram (300 dpi where it fits; the server picks the dpi).
  async downloadDiagramPng(source, theme) {
    try {
      const res = await fetch('/api/diagram/render/png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, theme }),
      });
      if (!res.ok) {
        const detail = await res.json().then((body) => body.detail).catch(() => '');
        throw new Error(detail || 'Could not render the PNG.');
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      const name = String(this.selectedNote?.title || 'diagram').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'diagram';
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

  renderMarkdownPreview(content) {
    const html = renderMarkdown(content, {
      isRoute: (pathname) => Boolean(notesRouter.getMatch(pathname)),
      decorate: (parsed) => { this._diagrams.markBlocks(parsed); this._diagrams.markEmbeds(parsed); },
    });
    return html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>/, ''); // the title is in the header
  }

  updateLivePreview(content) {
    const preview = this.querySelector('#notes-preview');
    const body = this.querySelector('#notes-md');
    if (!preview || !body) return;
    const scrollTop = preview.scrollTop;
    body.innerHTML = this.renderMarkdownPreview(content);
    const header = this.querySelector('app-header');
    const title = this.getTitleFromContent(content);
    if (header && title) header.heading = title;
    this.setupPreviewEvents();
    preview.scrollTop = scrollTop;
  }

  setupPreviewEvents() {
    const preview = this.querySelector('#notes-preview');
    if (!preview) return;
    preview.removeEventListener('click', this._previewClickHandler);
    preview.addEventListener('click', this._previewClickHandler);
    preview.removeEventListener('dropdown-select', this._diagramMenuHandler);
    preview.addEventListener('dropdown-select', this._diagramMenuHandler);
    this.decorateWikilinks(preview);
    this._diagrams.decorate(preview, { editing: this.isNoteEditing });
    this._diagrams.loadEmbeds(preview);
    setupCodeBlockActions(preview);
    this.preloadEditorWhenIdle();
  }

  // Resolve [[targets]] against the notes on disk: link them, label them, or mark them broken.
  async decorateWikilinks(preview) {
    const links = [...preview.querySelectorAll('.notes-wikilink')];
    const targets = [...new Set(links.map((link) => link.dataset.target).filter((target) => target && !target.startsWith('#')))];
    for (const link of links) if (link.dataset.target?.startsWith('#')) link.classList.remove('unresolved');
    if (!targets.length) return;
    let resolved;
    try {
      resolved = await api(`/resolve?${targets.map((target) => `target=${encodeURIComponent(target)}`).join('&')}`);
    } catch (error) {
      console.error('Failed to resolve wikilinks:', error);
      return;
    }
    if (!preview.isConnected) return;
    for (const link of links) {
      const hit = resolved[link.dataset.target];
      if (!hit) {
        if (!link.dataset.target.startsWith('#')) link.classList.add('unresolved');
        continue;
      }
      link.classList.remove('unresolved');
      link.dataset.slug = hit.slug;
      link.setAttribute('href', `/notes/${encodeURIComponent(hit.slug)}`);
      if (link.dataset.autoLabel === 'true') link.textContent = hit.title;
    }
  }

  handlePreviewClick(event) {
    const wikilink = event.target.closest('.notes-wikilink');
    if (!wikilink) return;
    event.preventDefault();
    event.stopPropagation();
    const target = wikilink.dataset.target || '';
    if (target.startsWith('#')) return;
    if (wikilink.dataset.slug) {
      const url = `/notes/${encodeURIComponent(wikilink.dataset.slug)}`;
      if (event.metaKey || event.ctrlKey || event.button === 1) window.open(url, '_blank');
      else this.go(url);
      return;
    }
    if (wikilink.classList.contains('unresolved')) this.promptCreateNoteFromWikilink(target);
  }

  promptCreateNoteFromWikilink(target) {
    const title = target.split('#', 1)[0].trim();
    if (!title) return;
    const { dialog, close } = openDialog(`
      ${dialogHeader('Create Note')}
      <div class="modal-body">Note &ldquo;<strong>${esc(title)}</strong>&rdquo; does not exist yet. Would you like to create it?</div>
      <div class="modal-footer">
        <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
        <button type="button" class="crud-drawer-btn primary" data-action="confirm-create"><i class="fa-solid fa-plus" aria-hidden="true"></i> Create Note</button>
      </div>`, { initialFocus: '[data-action="confirm-create"]' });
    dialog.querySelector('[data-action="confirm-create"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const created = await api('/notes', { method: 'POST', body: { content: `# ${title}\n\n`, tags: [] } });
        close();
        if (this.saveStatus === 'dirty') showToast(`Created ${created.slug}. Your unsaved edits are still here.`, 'success');
        else notesRouter.navigate(`/notes/${encodeURIComponent(created.slug)}?mode=edit`);
        if (this.selectedNote) this.refreshBacklinks(), this.setupPreviewEvents();
      } catch (error) {
        button.disabled = false;
        this.showAlert('Could Not Create Note', error.message);
      }
    });
  }
}

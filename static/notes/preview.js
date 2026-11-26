import { showToast } from '/static/toast.js';
import { renderMarkdownPreview as renderMarkdown } from '/static/notes/markdown.js';
import { setupCodeBlockActions } from '/static/notes/code-blocks.js';
import { notesRouter } from '/static/notes/notes-router.js';
import { decorateWikilinks, handleWikilinkClick, promptCreateNote } from '/static/notes/wikilinks.js';

export class Preview {
  getTitleFromContent(content) {
    const heading = /^#\s+(.+)$/m.exec(String(content || ''));
    return heading ? heading[1].trim() : '';
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
  decorateWikilinks(preview) {
    return decorateWikilinks(preview);
  }

  handlePreviewClick(event) {
    return handleWikilinkClick(event, {
      onNavigate: (url) => this.go(url),
      onCreate: (target) => this.promptCreateNoteFromWikilink(target),
      stopPropagation: true,
    });
  }

  promptCreateNoteFromWikilink(target) {
    promptCreateNote(target, {
      onCreated: (created) => {
        if (this.saveStatus === 'dirty') showToast(`Created ${created.slug}. Your unsaved edits are still here.`, 'success');
        else notesRouter.navigate(`/notes/${encodeURIComponent(created.slug)}?mode=edit`);
        if (this.selectedNote) this.refreshBacklinks(), this.setupPreviewEvents();
      },
      onError: (error) => this.showAlert('Could Not Create Note', error.message),
    });
  }
}

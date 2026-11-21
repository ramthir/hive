import { confirmDialog, confirmDiscard } from '/static/components/dialog.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/relative-time.js';
import '/static/components/action-bar.js';
import { SPOTLIGHT_SELECT_EVENT } from '/static/components/note-spotlight.js';
import { renderSearchTrigger, wireSearchTrigger } from '/static/components/search-trigger.js';
import { DEFAULT_TYPE, typeIcon, typeLabel, typeOptions } from '/static/type-icons.js';
import { configureMarkedWikilinks } from '/static/notes/markdown.js';
import { DiagramPreviews } from '/static/notes/diagrams.js';
import '/static/components/dropdown-menu.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';
import { openVersionHistory } from '/static/notes/history.js';
import { openLogTime, updateLogged } from '/static/notes/log-time.js';
import { tagChips, tagOptions } from '/static/notes/tags.js';
import { openProperties } from '/static/notes/properties.js';
import { formatDay, formatDuration } from '/static/time-entries/format.js';
import { canLogTime, loggedLabel } from '/static/time-entries/logged.js';
import { readPagePath } from '/static/notes/read-pages.js';
import { notesRouter } from '/static/notes/notes-router.js';
import { mixin } from '/static/mixin.js';
import { RemoteChanges } from '/static/notes/remote-changes.js';
import { Preview } from '/static/notes/preview.js';
import { CodeMirrorEditor } from '/static/notes/codemirror.js';
import { noteStats, updateSaveIndicator, updateUpdatedStamp } from '/static/notes/status-bar.js';

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const editShortcutKey = isMac ? '⌘E' : 'Ctrl+E';
const propertiesShortcutKey = isMac ? '⌘⇧P' : 'Ctrl+Shift+P';
const parseTags = (text) => [...new Set(String(text || '').split(',').map((tag) => tag.trim()).filter(Boolean))];


configureMarkedWikilinks();

/* --- The app ---------------------------------------------------------- */

class NotesApp extends HTMLElement {
  constructor() {
    super();
    this.currentView = 'list';
    this.selectedSlug = null;
    this.selectedNote = null;
    this.saveStatus = 'saved'; // 'saved' | 'saving' | 'dirty'
    this.isNoteEditing = false;
    this.cmEditor = null;
    this._unsubscribe = null;
    this._previewClickHandler = (event) => this.handlePreviewClick(event);
    // PlantUML previews: rendered diagrams are cached by source; failed sources are not retried until edited.
    this._diagrams = new DiagramPreviews((source) => api('/diagram/render', { method: 'POST', body: { source } }));
    this._diagramMenuHandler = (event) => {
      const figure = event.target.closest?.('.notes-diagram[data-diagram]');
      const theme = event.detail?.action;
      if (figure && (theme === 'dark' || theme === 'light')) this.downloadDiagramPng(figure.dataset.diagram, theme);
    };
  }

  connectedCallback() {
    if (window.location.pathname === '/') history.replaceState(null, '', '/notes');
    notesRouter.start();
    this._unsubscribe = notesRouter.subscribe((_path, route, params) => {
      if (this.guardUnsavedRoute(route, params)) return;
      this._shownUrl = window.location.pathname + window.location.search;
      this.handleRouting(route, params);
    });

    this._shellRoot = this.closest('app-shell')?.shadowRoot;
    this._sidebarClick = (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      this.go(url.pathname === '/notes' ? '/notes' : url.pathname + url.search);
    };
    this._shellRoot?.addEventListener('click', this._sidebarClick, true);
    this._spotlightHandler = (event) => {
      event.preventDefault();
      this.go(`/notes/${encodeURIComponent(event.detail.slug)}`);
    };
    window.addEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlightHandler);
    this._keydownHandler = (event) => this.handleGlobalKeydown(event);
    window.addEventListener('keydown', this._keydownHandler);
    this._beforeUnloadHandler = (event) => {
      if (this.currentView === 'editor' && this.saveStatus === 'dirty') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this._beforeUnloadHandler);
    notesRouter.refresh();
  }

  disconnectedCallback() {
    clearTimeout(this._copyTimer);
    this.stopWatching();
    this._diagrams.dispose();
    this.destroyCodeMirror();
    window.removeEventListener('keydown', this._keydownHandler);
    window.removeEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlightHandler);
    this._shellRoot?.removeEventListener('click', this._sidebarClick, true);
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._unsubscribe?.();
    notesRouter.stop();
  }

  /* --- Navigation ---------------------------------------------------- */

  // Every in-app navigation goes through here so unsaved edits are never dropped silently.
  async go(path, options) {
    if (this.currentView === 'editor' && this.saveStatus === 'dirty' && !(await this.confirmLeave())) return;
    // Other pages of the app (the task board) are separate documents, not routes of the notes router.
    if (path !== '/notes' && !path.startsWith('/notes/') && !path.startsWith('/notes?')) {
      window.location.assign(path);
      return;
    }
    notesRouter.navigate(path, options);
  }

  // Leaving a note with unsaved edits: save them and leave, discard them and leave, or stay. True when it is fine to go.
  async confirmLeave() {
    const answer = await confirmDiscard({
      title: 'Unsaved changes',
      message: 'Leave this note without saving?',
      confirmText: 'Discard',
      cancelText: 'Cancel',
      alternateText: 'Save and leave',
    });
    if (answer === 'alternate') {
      await this.saveCurrentNote();
      return this.saveStatus === 'saved'; // a refused or failed save keeps the reader here, with the reason shown
    }
    if (!answer) return false;
    this.saveStatus = 'saved';
    return true;
  }

  // Back/Forward and links the router handles itself (backlinks) do not go through go(). If one of them would leave a note
  // with unsaved edits, put the address back, ask, and only then go where it pointed.
  guardUnsavedRoute(route, params) {
    if (this.currentView !== 'editor' || this.saveStatus !== 'dirty' || !this._shownUrl) return false;
    const stays = route?.view === 'editor' && (route.isNew ? !this.selectedSlug : decodeURIComponent(params?.slug || '') === this.selectedSlug);
    if (stays) return false;
    const target = window.location.pathname + window.location.search;
    history.pushState(null, '', this._shownUrl);
    this.confirmLeave().then((leave) => {
      if (leave) notesRouter.navigate(target);
    });
    return true;
  }

  handleGlobalKeydown(event) {
    // A drawer or dialog is open: its keys are its own (Ctrl+E would redraw the page under it, Ctrl+Shift+P stack a second drawer).
    if (document.body.classList.contains('dialog-open')) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (this.currentView === 'editor' && this.selectedNote && this.saveStatus === 'dirty') this.saveCurrentNote();
    } else if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      if (this.currentView === 'editor' && this.selectedNote?.has_properties) this.openProperties();
    } else if ((event.metaKey || (!isMac && event.ctrlKey)) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      if (this.currentView === 'editor' && this.selectedNote) this.setNoteEditing(!this.isNoteEditing);
    }
  }

  handleRouting(route, params) {
    if (route?.view === 'editor' && route.isNew) {
      if (this.currentView === 'editor' && this.selectedSlug === null && this.selectedNote && !this.selectedNote.slug) return;
      this.currentView = 'editor';
      this.selectedSlug = null;
      this.stopWatching();
      this.isNoteEditing = true;
      this.startNewDraftNote();
      return;
    }
    if (route?.view === 'editor' && params?.slug) {
      const slug = decodeURIComponent(params.slug);
      const startInEdit = new URLSearchParams(window.location.search).get('mode') === 'edit';
      // Same note, only ?mode= changed: flip local state instead of refetching.
      if (this.currentView === 'editor' && this.selectedSlug === slug && this.selectedNote) {
        if (this.isNoteEditing !== startInEdit) {
          this.isNoteEditing = startInEdit;
          if (!startInEdit) this.destroyCodeMirror();
          this.renderEditorView();
          if (startInEdit) setTimeout(() => this.focusEditor(), 0);
        }
        return;
      }
      this.currentView = 'editor';
      this.selectedSlug = slug;
      this.stopWatching();
      this.isNoteEditing = false;
      this.renderRouteLoading();
      this.loadEditorNote(slug, { startInEdit });
      return;
    }
    // No home page: the notes root shows the note that was edited most recently.
    this.destroyCodeMirror();
    this.currentView = 'list';
    this.selectedSlug = null;
    this.selectedNote = null;
    this.stopWatching();
    this.saveStatus = 'saved';
    this.renderRouteLoading();
    this.openLatestNote();
  }

  /* --- Data ---------------------------------------------------------- */

  async openLatestNote() {
    if (this._openingLatest) return;
    this._openingLatest = true;
    try {
      const latest = await api('/latest').catch((error) => {
        if (error.status === 404) return null; // no notes yet
        throw error;
      });
      if (this.currentView !== 'list') return; // the user already went somewhere else
      notesRouter.navigate(latest ? `/notes/${encodeURIComponent(latest.slug)}` : '/notes/new', { replace: true });
    } catch (error) {
      console.error('Failed to open the latest note:', error);
      showToast(error.message || 'Could not load notes.', 'error');
    } finally {
      this._openingLatest = false;
    }
  }

  async loadEditorNote(slug, { startInEdit = false } = {}) {
    try {
      const note = await api(`/notes/${encodeURIComponent(slug)}`);
      if (this.selectedSlug !== slug) return; // a newer navigation won
      this.selectedNote = note;
      this.saveStatus = 'saved';
      this.isNoteEditing = startInEdit;
      this.destroyCodeMirror();
      this.renderEditorView();
      this.watchNote(slug);
      if (startInEdit) setTimeout(() => this.focusEditor(), 50);
    } catch (error) {
      console.error('Failed to load note:', error);
      if (this.selectedSlug !== slug) return;
      if (error.status === 404) {
        showToast('That note does not exist (any more).', 'error');
        notesRouter.navigate('/notes', { replace: true });
      } else {
        this.renderLoadError(slug, error.message); // stay on this note's address: Retry loads it again
      }
    }
  }

  renderLoadError(slug, message) {
    this.renderRouteLoading();
    const section = this.querySelector('.notes-editor-page');
    section.removeAttribute('aria-busy');
    section.classList.remove('notes-editor--skeleton');
    const pane = this.querySelector('.notes-preview-pane');
    pane.classList.remove('notes-preview-pane--skeleton');
    pane.removeAttribute('aria-hidden');
    pane.innerHTML = `
      <div class="notes-load-error" role="alert">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <p>Could not load this note: ${esc(message || 'something went wrong')}.</p>
        <button type="button" class="crud-drawer-btn primary" id="retry-load-btn">Try again</button>
      </div>`;
    this.querySelector('#retry-load-btn').addEventListener('click', () => {
      this.renderRouteLoading();
      this.loadEditorNote(slug, { startInEdit: new URLSearchParams(window.location.search).get('mode') === 'edit' });
    });
  }

  createNewNote() {
    return this.go('/notes/new');
  }

  startNewDraftNote() {
    // The title is the first heading, so a new note starts with an empty one for the cursor to land in.
    this.selectedNote = { slug: null, title: '', content: '# \n\n', tags: [], created: null, updated: null };
    this.saveStatus = 'saved';
    this.destroyCodeMirror();
    this.renderEditorView();
    setTimeout(() => this.focusEditor(), 50);
  }

  currentContent() {
    return this.cmEditor ? this.cmEditor.state.doc.toString() : this.selectedNote?.content || '';
  }

  markDirty() {
    if (this.saveStatus === 'saving') this._editedWhileSaving = true; // the save in flight does not include this edit
    else this.saveStatus = 'dirty';
    updateSaveIndicator(this, this.saveStatus);
  }

  async saveCurrentNote() {
    const note = this.selectedNote;
    if (!note || this.saveStatus === 'saving') return;
    const isNewDraft = !note.slug;
    const content = this.currentContent();
    const tags = parseTags(this.querySelector('#note-tags')?.value ?? note.tags.join(', '));
    const types = parseTags(this.querySelector('#note-type')?.value ?? (note.types || []).join(', '));

    this.saveStatus = 'saving';
    this._editedWhileSaving = false;
    updateSaveIndicator(this, this.saveStatus);
    try {
      const saved = isNewDraft
        ? await api('/notes', { method: 'POST', body: { content, tags, types } })
        : await api(`/notes/${encodeURIComponent(note.slug)}`, { method: 'PUT', body: { content, tags, types, revision: note.revision } });
      this.selectedNote = saved;
      // The server may normalise the text (e.g. a pre-commit formatter); keep the caret if nothing changed meanwhile.
      if (this.cmEditor && saved.content !== content && this.cmEditor.state.doc.toString() === content) {
        const head = Math.min(this.cmEditor.state.selection.main.head, saved.content.length);
        this.cmEditor.dispatch({ changes: { from: 0, to: content.length, insert: saved.content }, selection: { anchor: head } });
      }
      // Anything typed while the request was out is not in the commit: the note is still unsaved.
      this.saveStatus = this._editedWhileSaving ? 'dirty' : 'saved';
      this._editedWhileSaving = false;
      updateSaveIndicator(this, this.saveStatus);
      if (isNewDraft || saved.slug !== note.slug) {
        // A new note, or a changed heading that renamed the file: move the URL to the new file name.
        this.selectedSlug = saved.slug;
        this.watchNote(saved.slug);
        notesRouter.navigate(`/notes/${encodeURIComponent(saved.slug)}?mode=edit`, { replace: true });
        this.renderEditorView({ keepEditor: true });
      } else {
        // A changed type can add or remove the properties button (and the log time one).
        if (Boolean(saved.has_properties) !== Boolean(note.has_properties) || canLogTime(saved) !== canLogTime(note)) this.renderEditorView({ keepEditor: true });
        updateUpdatedStamp(this, this.selectedNote);
        this.updateDocumentTitle();
        this.refreshBacklinks();
      }
    } catch (error) {
      console.error('Save failed:', error);
      this.saveStatus = 'dirty';
      updateSaveIndicator(this, this.saveStatus);
      if (error.status === 412) return this.resolveConflict(note);
      this.showAlert('Could Not Save Note', error.message);
    }
  }

  // The file changed (another tab, an editor, git) after this page loaded it. Saving anyway replaces that change with this
  // page's text. It is only recoverable from the history if the other change was committed, so the dialog does not promise it.
  async resolveConflict(note) {
    const overwrite = await confirmDialog({
      title: 'Note changed elsewhere',
      message: 'This note was changed after you opened it. Saving now replaces that change with your text. Copy your text first if you want to merge by hand.',
      confirmText: 'Overwrite',
      cancelText: 'Keep editing',
      danger: true,
    });
    if (!overwrite || this.selectedNote !== note) return;
    try {
      note.revision = (await api(`/notes/${encodeURIComponent(note.slug)}`)).revision;
    } catch (error) {
      this.showAlert('Could Not Save Note', error.message);
      return;
    }
    return this.saveCurrentNote();
  }

  async confirmDeleteCurrentNote() {
    const note = this.selectedNote;
    if (!note?.slug) return;
    // A note that others link to cannot be deleted: list them so each can be opened and its link removed.
    const linking = await api(`/notes/${encodeURIComponent(note.slug)}/backlinks`).then((data) => data.backlinks.filter((other) => other.slug !== note.slug), () => []);
    if (linking.length) {
      const items = linking.map((other) => `<li><a class="notes-wikilink" href="/notes/${esc(encodeURIComponent(other.slug))}" data-route>${esc(other.title)}</a></li>`).join('');
      const { dialog, close } = openDialog(`
        ${dialogHeader('Cannot Delete Note')}
        <div class="modal-body modal-alert-body"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>"${esc(note.title)}" is linked from ${linking.length === 1 ? '1 other note' : `${linking.length} other notes`}. Open ${linking.length === 1 ? 'it' : 'them'} and remove the link before deleting.<ul class="confirm-dialog-details" id="linked-notes">${items}</ul></span></div>
        <div class="modal-footer"><button type="button" class="crud-drawer-btn primary" data-dialog-close>Close</button></div>`,
      { className: 'notes-save-error-dialog-host', initialFocus: '.modal-footer [data-dialog-close]' });
      dialog.setAttribute('role', 'alertdialog');
      dialog.querySelectorAll('#linked-notes a').forEach((a) => a.addEventListener('click', close));
      return;
    }
    const confirmed = await confirmDialog({
      title: 'Delete Note?',
      message: `Delete "${note.title}"? The file is removed and the deletion is committed; you can recover it from git history.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/notes/${encodeURIComponent(note.slug)}`, { method: 'DELETE' });
      this.saveStatus = 'saved';
      this.selectedNote = null;
      this.selectedSlug = null;
      notesRouter.navigate('/notes', { replace: true });
    } catch (error) {
      this.showAlert('Could Not Delete Note', error.message);
    }
  }

  showAlert(title, message) {
    const { dialog } = openDialog(`
      ${dialogHeader(title)}
      <div class="modal-body modal-alert-body"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(message || 'Something went wrong.')}</span></div>
      <div class="modal-footer"><button type="button" class="crud-drawer-btn primary" data-dialog-close>Close</button></div>`,
    { className: 'notes-save-error-dialog-host', initialFocus: '.modal-footer [data-dialog-close]' });
    dialog.setAttribute('role', 'alertdialog');
  }

  async setNoteEditing(editing) {
    if (editing === this.isNoteEditing) return;
    if (!editing && this.saveStatus === 'saving') return;
    if (!editing && this.saveStatus === 'dirty') {
      const confirmed = await confirmDialog({
        title: 'Unsaved changes',
        message: 'Save your changes before closing the Markdown editor?',
        confirmText: 'Save and close',
        cancelText: 'Keep editing',
      });
      if (!confirmed) return;
      await this.saveCurrentNote();
      if (this.saveStatus !== 'saved') return;
    }
    this.isNoteEditing = editing;
    if (!editing) this.destroyCodeMirror();
    // Keep what was typed in the tags input across the re-render.
    this.captureMeta();
    this.renderEditorView();
    if (editing) setTimeout(() => this.focusEditor(), 0);
    const url = new URL(window.location.href);
    if (editing) url.searchParams.set('mode', 'edit');
    else url.searchParams.delete('mode');
    notesRouter.navigate(url.href, { replace: true });
  }

  captureMeta() {
    const note = this.selectedNote;
    if (!note) return;
    note.content = this.currentContent();
    const tags = this.querySelector('#note-tags');
    if (tags && 'value' in tags) note.tags = parseTags(tags.value); // the chips of read mode hold no text to read back
    const type = this.querySelector('#note-type');
    if (type) note.types = parseTags(type.value);
  }

  /* --- List view ----------------------------------------------------- */

  renderRouteLoading() {
    this.innerHTML = `
      <section class="notes-page notes-editor-page notes-editor--skeleton" aria-busy="true">
        <app-header heading="Notes" variant="flush" attached>
          <div slot="actions" class="notes-header-actions app-header-action-group">
            ${renderSearchTrigger()}
          </div>
        </app-header>
        <div class="notes-editor-workspace preview">
          <div class="notes-preview-pane notes-preview-pane--skeleton" aria-hidden="true">
            <div class="note-skeleton-doc">
              <span class="note-skeleton note-skeleton-heading"></span>
              <span class="note-skeleton note-skeleton-body-line note-skeleton-body-line--full"></span>
              <span class="note-skeleton note-skeleton-body-line note-skeleton-body-line--90"></span>
              <span class="note-skeleton note-skeleton-body-line note-skeleton-body-line--75"></span>
            </div>
          </div>
        </div>
      </section>`;
    this.bindHeader();
  }

  /* --- Editor view --------------------------------------------------- */

  // `keepEditor`: redraw the page around the CodeMirror that is already open (its caret, undo history and scroll stay),
  // for a save that renamed the file or changed which buttons the note has.
  renderEditorView({ keepEditor = false } = {}) {
    if (!this.selectedNote) return;
    const note = this.selectedNote;
    const editing = this.isNoteEditing;
    const kept = keepEditor && editing && this.cmEditor
      ? { dom: this.cmEditor.dom, scroll: this.cmEditor.scrollDOM.scrollTop, preview: this.querySelector('#notes-preview')?.scrollTop || 0 }
      : null;
    // Table and timeline notes are read on their own page (READ_PAGES); the pencil there comes back here in edit mode.
    const readPath = !editing && readPagePath(note);
    if (readPath) {
      window.location.replace(readPath);
      return;
    }
    const { words, chars, readingMinutes } = noteStats(note.content);
    const hideTags = !editing && !(note.tags || []).length; // nothing to show or edit

    this.innerHTML = `
      <section class="notes-page notes-editor-page">
        <app-header heading="${esc(note.title || 'New note')}" variant="flush" attached>
          <div slot="actions" class="notes-header-actions app-header-action-group">
            ${renderSearchTrigger()}
          </div>
        </app-header>
        <div class="notes-editor-workspace ${editing ? 'write' : 'preview'}">
          <div class="notes-preview-pane" id="notes-preview" tabindex="0">
            <div id="notes-md">${this.renderMarkdownPreview(kept ? this.currentContent() : note.content)}</div>
            <div id="notes-backlinks"></div>
          </div>
          ${editing ? '<aside class="notes-editor-pane notes-markdown-drawer" aria-label="Markdown editor"><div class="notes-cm-wrapper" id="notes-cm-editor"></div></aside>' : ''}
        </div>

        <app-action-bar fixed class="notes-action-bar" aria-label="Note status and actions">
          <div class="action-bar-left notes-footer-left">
            ${editing
              ? `<app-combobox id="note-type" class="action-bar-combobox notes-types-combobox" multiple creatable value="${esc((note.types || []).join(','))}" placeholder="${typeLabel(DEFAULT_TYPE)}" aria-label="Note type" title="Note type"></app-combobox>`
              : `<span class="notes-type-label" title="${esc(note.slug ? `${note.slug}.md` : 'New note')}">
              ${(note.types?.length ? note.types : [DEFAULT_TYPE]).map((type) => `<span class="notes-type-chip"><i class="fa-solid fa-${typeIcon(type)}" aria-hidden="true"></i><span class="notes-type-name">${esc(type)}</span></span>`).join('')}
            </span>`}
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="notes-footer-stats" title="${chars.toLocaleString()} characters">
              <i class="fa-solid fa-align-left notes-stats-icon" aria-hidden="true"></i>
              <span class="stat-words"><span class="stat-value">${words.toLocaleString()}</span> words</span>
              <span class="stat-bullet" aria-hidden="true">•</span>
              <span class="stat-reading"><span class="stat-value">${readingMinutes}</span> min read</span>
            </div>
            ${editing ? '' : `<span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="action-bar-status notes-footer-status">
              <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
                <i class="fa-regular fa-clock" aria-hidden="true"></i>
                <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
              </span>
            </div>`}
            ${canLogTime(note) ? `<span class="stat-logged" title="Time logged on this note"${loggedLabel(note.time) ? '' : ' hidden'}><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> <span>${esc(loggedLabel(note.time))}</span></span>` : ''}
            <span class="action-bar-divider notes-footer-divider notes-footer-tags-divider" aria-hidden="true"${hideTags ? ' hidden' : ''}></span>
            <label class="notes-footer-tags"${hideTags ? ' hidden' : ''}>
              <i class="fa-solid fa-tags" aria-hidden="true"></i>
              ${editing
                ? `<app-combobox id="note-tags" class="action-bar-combobox notes-tags-combobox" multiple creatable value="${esc((note.tags || []).join(','))}" placeholder="Add tags" aria-label="Tags"></app-combobox>`
                : `<span id="note-tags" class="notes-tags-chips" role="group" aria-label="Tags">${tagChips(note.tags)}</span>`}
            </label>
          </div>
          <div class="action-bar-right notes-footer-actions">
            <div class="map-toolbar" aria-label="Note actions">
              ${note.slug ? `
                <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>` : ''}
              <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
              ${note.slug && note.has_properties ? `<button id="note-properties-btn" class="tool-button" type="button" title="Edit note properties (${propertiesShortcutKey})" aria-label="Edit note properties"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>` : ''}
              ${canLogTime(note) ? '<button id="log-time-btn" class="tool-button" type="button" title="Log time" aria-label="Log time"><i class="fa-solid fa-clock" aria-hidden="true"></i></button>' : ''}
              ${note.slug ? '<button id="note-versions-btn" class="tool-button" type="button" title="History" aria-label="History"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>' : ''}
              ${editing ? `
                <span class="tool-divider" aria-hidden="true"></span>
                <button id="save-note-btn" class="tool-button save ${this.saveStatus === 'dirty' ? 'dirty' : 'clean'}" type="button" title="Save note (${isMac ? '⌘S' : 'Ctrl+S'})" aria-label="Save note"${this.saveStatus === 'dirty' ? '' : ' disabled'}><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i></button>` : ''}
              <button id="edit-note-btn" class="tool-button notes-edit-toggle" type="button" title="${editing ? 'Close editor' : 'Edit note'} (${editShortcutKey})" aria-label="Edit note" aria-pressed="${editing}"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>
            </div>
          </div>
        </app-action-bar>
      </section>`;

    this.updateDocumentTitle();
    this.querySelector('#copy-note-btn').addEventListener('click', () => this.copyCurrentNote());
    this.querySelector('#note-versions-btn')?.addEventListener('click', () => this.openNoteVersions());
    this.querySelector('#log-time-btn')?.addEventListener('click', () => this.openLogTime());
    this.querySelector('#note-properties-btn')?.addEventListener('click', () => this.openProperties());
    this.querySelector('#delete-note-btn')?.addEventListener('click', () => this.confirmDeleteCurrentNote());
    this.querySelector('#edit-note-btn').addEventListener('click', () => this.setNoteEditing(!this.isNoteEditing));
    this.querySelector('#save-note-btn')?.addEventListener('click', () => this.saveCurrentNote());
    this.bindHeader();
    const tagField = this.querySelector('#note-tags');
    if (tagField?.localName === 'app-combobox') this.setupTagCombobox(tagField);
    else tagField?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-tag]');
      if (chip) document.querySelector('note-spotlight')?.open(chip.dataset.tag);
    });
    const typeField = this.querySelector('#note-type');
    if (typeField) this.setupTypeCombobox(typeField);

    if (kept) {
      this.querySelector('#notes-cm-editor').appendChild(kept.dom);
      this.cmEditor.scrollDOM.scrollTop = kept.scroll;
      this.querySelector('#notes-preview').scrollTop = kept.preview;
      this.cmEditor.focus();
    } else if (editing) {
      this.initCodeMirror();
    }
    this.setupPreviewEvents();
    this.refreshBacklinks();
  }

  // Tags are chips; the suggestions are the tags in use in the vault, and what is typed can be added as a new one.
  setupTagCombobox(combobox) {
    const options = () => tagOptions(this._vaultTags, this.selectedNote?.tags);
    combobox.optionsList = options();
    combobox.addEventListener('change', () => this.markDirty());
    api('/tags').then((counts) => {
      this._vaultTags = counts;
      if (!combobox.isConnected) return;
      combobox.optionsList = options();
      if (combobox.opened) combobox.drawOptions();
    }).catch(() => {});
  }

  // The footer's tag field after the tags changed outside it (saving the priority in the properties drawer drops an older note's priority tag).
  showTags(tags) {
    const field = this.querySelector('#note-tags');
    if (!field) return;
    if (field.localName === 'app-combobox') field.value = tags.join(',');
    else field.innerHTML = tagChips(tags);
    for (const el of this.querySelectorAll('.notes-footer-tags, .notes-footer-tags-divider')) el.hidden = !tags.length && !this.isNoteEditing;
  }

  // Types are chips like tags: the known types (with icons) and those in use in the vault are suggested, and what is typed can be
  // added as a new one. Picking or removing one marks the note dirty.
  setupTypeCombobox(combobox) {
    const options = () => typeOptions(this._vaultTypes, this.selectedNote?.types);
    combobox.optionsList = options();
    combobox.addEventListener('change', () => this.markDirty());
    if (!this._vaultTypes) {
      api('/types').then((counts) => {
        this._vaultTypes = Object.keys(counts);
        if (!combobox.isConnected) return;
        combobox.optionsList = options();
        if (combobox.opened) combobox.drawOptions();
      }).catch(() => {});
    } else {
      combobox.optionsList = options();
    }
  }

  // The note's title is the header's heading (the preview leaves out the content's own first
  // heading) and the browser tab's.
  updateDocumentTitle() {
    const title = this.selectedNote?.title || 'New note';
    document.title = `${title} - Hive`;
    const header = this.querySelector('app-header');
    if (header && header.heading !== title) header.heading = title;
  }

  bindHeader() {
    const header = this.querySelector('app-header');
    if (!header) return;
    if (this.selectedNote) this.updateDocumentTitle();
    wireSearchTrigger(this);
  }

  /* --- Backlinks ----------------------------------------------------- */

  async refreshBacklinks() {
    const slug = this.selectedNote?.slug;
    const container = this.querySelector('#notes-backlinks');
    if (!container) return;
    if (!slug) {
      container.innerHTML = '';
      return;
    }
    try {
      const data = await api(`/notes/${encodeURIComponent(slug)}/backlinks`);
      if (!container.isConnected || this.selectedNote?.slug !== slug) return;
      const link = (note) => `<li><a class="notes-wikilink" href="/notes/${esc(encodeURIComponent(note.slug))}" data-route>${esc(note.title)}</a></li>`;
      const missing = data.unresolved.filter((target) => !target.startsWith('#'));
      container.className = data.backlinks.length || missing.length ? 'notes-backlinks' : '';
      container.innerHTML = `
        ${data.backlinks.length ? `<h2>Referenced</h2><ul>${data.backlinks.map(link).join('')}</ul>` : ''}
        ${missing.length ? `<h2>Broken links</h2><ul class="unresolved-list">${missing.map((target) => `<li><a href="#" data-create="${esc(target)}">${esc(target)}</a></li>`).join('')}</ul>` : ''}`;
      container.querySelectorAll('[data-create]').forEach((a) => a.addEventListener('click', (event) => {
        event.preventDefault();
        this.promptCreateNoteFromWikilink(a.dataset.create);
      }));
    } catch (error) {
      console.error('Failed to load backlinks:', error);
    }
  }

  async copyCurrentNote() {
    try {
      await copyTextToClipboard(this.currentContent());
      const button = this.querySelector('#copy-note-btn');
      if (!button) return;
      button.classList.add('copied');
      button.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        button.classList.remove('copied');
        button.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>';
      }, 2000);
    } catch (error) {
      console.error('Failed to copy note:', error);
    }
  }

  /* --- Time ----------------------------------------------------------- */

  // Logging time commits only the note's `time` key; the text in the editor (saved or not) is left alone.
  openLogTime() {
    const note = this.selectedNote;
    if (!note || !canLogTime(note)) return;
    const applied = (fresh) => {
      if (this.selectedNote?.slug !== note.slug) return false;
      this.selectedNote = { ...this.selectedNote, time: fresh.time, updated: fresh.updated, revision: fresh.revision };
      updateUpdatedStamp(this, this.selectedNote);
      updateLogged(this, this.selectedNote);
      return true;
    };
    openLogTime(note, {
      onLogged: (fresh, minutes) => {
        if (applied(fresh)) showToast(`Logged ${formatDuration(minutes)} · ${note.title}`, 'success');
      },
      onRemoved: (fresh, day) => {
        if (applied(fresh)) showToast(`Removed ${formatDay(day)} · ${note.title}`, 'success');
      },
    });
  }

  /* --- Properties ------------------------------------------------------ */

  // Unsaved text is saved first, so the drawer's commit (status, priority and tags can change the tags) never loses it.
  async openProperties() {
    if (!this.selectedNote?.slug || !this.selectedNote.has_properties || this._propertiesOpening) return;
    this._propertiesOpening = true;
    try {
      if (this.saveStatus === 'dirty') await this.saveCurrentNote();
      if (this.saveStatus === 'dirty') return; // the save failed and said why
      const note = this.selectedNote;
      if (!note?.slug) return;
      await openProperties(note, {
        onSaved: (saved) => {
          if (this.selectedNote?.slug !== note.slug) return;
          this.selectedNote = saved;
          this.showTags(saved.tags);
          updateUpdatedStamp(this, saved);
          showToast(`Properties saved · ${saved.title}`, 'success');
        },
      });
    } finally {
      this._propertiesOpening = false;
    }
  }

  /* --- History (git) ------------------------------------------------- */

  // Unsaved text is saved first (as in the properties drawer): the history and "compare with current" then show
  // the note as it really is, and a restore cannot throw the edits away, because they stay one commit back.
  async openNoteVersions() {
    if (!this.selectedNote?.slug || this._historyOpening) return;
    this._historyOpening = true;
    try {
      if (this.saveStatus === 'dirty') await this.saveCurrentNote();
      if (this.saveStatus === 'dirty') return; // the save failed and said why
      const slug = this.selectedNote?.slug;
      if (!slug) return;
      await this.showVersionHistory(slug);
    } finally {
      this._historyOpening = false;
    }
  }

  showVersionHistory(slug) {
    return openVersionHistory(slug, {
      onRestored: (restored) => {
        this.saveStatus = 'saved';
        this.destroyCodeMirror();
        this.selectedSlug = restored.slug;
        notesRouter.navigate(`/notes/${encodeURIComponent(restored.slug)}${this.isNoteEditing ? '?mode=edit' : ''}`, { replace: true });
        this.loadEditorNote(restored.slug, { startInEdit: this.isNoteEditing });
      },
    });
  }
}

mixin(NotesApp, RemoteChanges, Preview, CodeMirrorEditor);

customElements.define('notes-app', NotesApp);

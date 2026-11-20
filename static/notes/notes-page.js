import { ScopedRouter } from '/static/scoped-router.js';
import { createDialog, confirmDialog, confirmDiscard } from '/static/components/dialog.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/time-format.js';
import '/static/components/action-bar.js';
import { SPOTLIGHT_SELECT_EVENT } from '/static/components/note-spotlight.js';
import { createPlantUmlLanguage } from '/static/notes/plantuml-lang.js';

const notesRouter = new ScopedRouter({ basename: '/notes' });
notesRouter.register('/notes', { view: 'list' });
notesRouter.register('/notes/new', { view: 'editor', isNew: true });
notesRouter.register('/notes/:slug', { view: 'editor' });
notesRouter.registerFallback({ view: 'list' });

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const editShortcutKey = isMac ? '⌘E' : 'Ctrl+E';
const searchShortcutKey = isMac ? '⌘K' : 'Ctrl+K';
const READING_WORDS_PER_MINUTE = 75;
const DEFAULT_TYPE = 'note';
// Icons for the usual types; anything else gets the plain file icon.
const TYPE_ICONS = { task: 'list-check', contact: 'user', project: 'folder', meeting: 'calendar-check', clipping: 'paperclip', book: 'book' };
// A note can have several types; the first one picks the icon.
const typeIcon = (types) => TYPE_ICONS[String((types || [])[0] || '').toLowerCase()] || 'file-lines';

/* --- API ------------------------------------------------------------- */

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : null;
    const error = new Error(detail || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

const parseTags = (text) => [...new Set(String(text || '').split(',').map((tag) => tag.trim()).filter(Boolean))];

/* --- Markdown: [[wikilinks]] ----------------------------------------- */

let _markedWikilinkConfigured = false;

// A table row is split on every unescaped "|" before inline parsing, so the alias
// separator in [[target|label]] must be escaped inside table rows to stay one cell.
function escapeWikilinkPipesInTableRows(markdown) {
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

function configureMarkedWikilinks(markedLib) {
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

configureMarkedWikilinks();

/* --- Editor (CodeMirror is ~670 KB; loaded on first edit or when idle) -- */

let sqlLanguage = null;
let shellLanguage = null;
let plantumlLanguage = null;
let editorModules = null;
const loadEditor = () => {
  editorModules ||= Promise.all([
    import('/static/vendor/codemirror.bundle.js'),
    import('/static/components/editor.js'),
  ]).then(([codemirror, editor]) => {
    sqlLanguage = codemirror.sql().language;
    shellLanguage = codemirror.StreamLanguage.define(codemirror.shellMode);
    plantumlLanguage = createPlantUmlLanguage(codemirror.StreamLanguage);
    return { markdown: codemirror.markdown, createEditor: editor.createEditor };
  }).catch((error) => {
    editorModules = null;
    throw error;
  });
  return editorModules;
};
const fencedCodeLanguage = (info) => {
  const language = String(info || '').trim().toLowerCase();
  if (language === 'sql') return sqlLanguage;
  if (['bash', 'sh', 'shell'].includes(language)) return shellLanguage;
  if (['plantuml', 'puml'].includes(language)) return plantumlLanguage;
  return null;
};

/* --- Dialog helper ---------------------------------------------------- */

function openDialog(innerHtml, { className = '', initialFocus = null, wide = false } = {}) {
  const dialog = document.createElement('app-dialog');
  dialog.className = `modal-backdrop is-hidden ${className}`;
  dialog.innerHTML = `<div class="modal-panel${wide ? ' modal-panel--drawer modal-panel--drawer-wide' : ''}" tabindex="-1">${innerHtml}</div>`;
  document.body.appendChild(dialog);
  const controller = createDialog(dialog, { closeOnBackdrop: true, initialFocus });
  const close = () => {
    controller.close();
    setTimeout(() => dialog.remove(), 220);
  };
  controller.open({ onClose: () => setTimeout(() => dialog.remove(), 220) });
  dialog.querySelectorAll('[data-action="cancel"]').forEach((el) => el.addEventListener('click', close));
  return { dialog, close };
}

const dialogHeader = (title) => `
  <div class="modal-header">
    <h2 class="modal-title">${esc(title)}</h2>
    <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
  </div>`;

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
  }

  connectedCallback() {
    if (window.location.pathname === '/') history.replaceState(null, '', '/notes');
    notesRouter.start();
    this._unsubscribe = notesRouter.subscribe((_path, route, params) => this.handleRouting(route, params));

    this._spotlightHandler = (event) => this.go(`/notes/${encodeURIComponent(event.detail.slug)}`);
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
    this.destroyCodeMirror();
    window.removeEventListener('keydown', this._keydownHandler);
    window.removeEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlightHandler);
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._unsubscribe?.();
    notesRouter.stop();
  }

  /* --- Navigation ---------------------------------------------------- */

  // Every in-app navigation goes through here so unsaved edits are never dropped silently.
  async go(path, options) {
    if (this.currentView === 'editor' && this.saveStatus === 'dirty') {
      const confirmed = await confirmDiscard({
        title: 'Unsaved changes',
        message: 'Leave this note without saving?',
        confirmText: 'Discard',
        cancelText: 'Cancel',
      });
      if (!confirmed) return;
      this.saveStatus = 'saved';
    }
    notesRouter.navigate(path, options);
  }

  handleGlobalKeydown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (this.currentView === 'editor' && this.selectedNote && this.saveStatus === 'dirty') this.saveCurrentNote();
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
      if (startInEdit) setTimeout(() => this.focusEditor(), 50);
    } catch (error) {
      console.error('Failed to load note:', error);
      if (this.selectedSlug !== slug) return;
      if (error.status !== 404) showToast(error.message || 'Could not load note.', 'error');
      notesRouter.navigate('/notes', { replace: true });
    }
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
    if (this.saveStatus !== 'saving') this.saveStatus = 'dirty';
    this.updateSaveIndicator();
  }

  async saveCurrentNote() {
    const note = this.selectedNote;
    if (!note || this.saveStatus === 'saving') return;
    const isNewDraft = !note.slug;
    const content = this.currentContent();
    const tags = parseTags(this.querySelector('#note-tags')?.value ?? note.tags.join(', '));
    const types = parseTags(this.querySelector('#note-type')?.value ?? (note.types || []).join(', '));

    this.saveStatus = 'saving';
    this.updateSaveIndicator();
    try {
      const saved = isNewDraft
        ? await api('/notes', { method: 'POST', body: { content, tags, types } })
        : await api(`/notes/${encodeURIComponent(note.slug)}`, { method: 'PUT', body: { content, tags, types } });
      this.selectedNote = saved;
      // The server may normalise the text (e.g. a pre-commit formatter); keep the caret if nothing changed meanwhile.
      if (this.cmEditor && saved.content !== content && this.cmEditor.state.doc.toString() === content) {
        const head = Math.min(this.cmEditor.state.selection.main.head, saved.content.length);
        this.cmEditor.dispatch({ changes: { from: 0, to: content.length, insert: saved.content }, selection: { anchor: head } });
      }
      this.saveStatus = 'saved';
      this.updateSaveIndicator();
      if (isNewDraft || saved.slug !== note.slug) {
        // A new note, or a changed heading that renamed the file: move the URL to the new file name.
        this.selectedSlug = saved.slug;
        notesRouter.navigate(`/notes/${encodeURIComponent(saved.slug)}?mode=edit`, { replace: true });
        this.renderEditorView();
      } else {
        this.updateUpdatedStamp();
        this.updateDocumentTitle();
        this.refreshBacklinks();
      }
      showToast(`Saved · ${saved.title}`, 'success');
    } catch (error) {
      console.error('Save failed:', error);
      this.saveStatus = 'dirty';
      this.updateSaveIndicator();
      this.showAlert('Could Not Save Note', error.message);
    }
  }

  async confirmDeleteCurrentNote() {
    const note = this.selectedNote;
    if (!note?.slug) return;
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
    if (tags) note.tags = parseTags(tags.value);
    const type = this.querySelector('#note-type');
    if (type) note.types = parseTags(type.value);
  }

  /* --- List view ----------------------------------------------------- */

  renderRouteLoading() {
    this.innerHTML = `
      <section class="notes-page notes-editor-page notes-editor--skeleton" aria-busy="true">
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
  }

  /* --- Editor view --------------------------------------------------- */

  renderEditorView() {
    if (!this.selectedNote) return;
    const note = this.selectedNote;
    const editing = this.isNoteEditing;
    const words = (note.content || '').trim().split(/\s+/).filter(Boolean).length;
    const chars = (note.content || '').length;
    const readingMinutes = words ? Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE)) : 0;
    const ro = editing ? '' : ' readonly';
    const hideTags = !editing && !(note.tags || []).length; // nothing to show or edit

    this.innerHTML = `
      <section class="notes-page notes-editor-page">
        <div class="notes-editor-workspace ${editing ? 'write' : 'preview'}">
          <div class="notes-preview-pane" id="notes-preview" tabindex="0">
            <div id="notes-md">${this.renderMarkdownPreview(note.content)}</div>
            <div id="notes-backlinks"></div>
          </div>
          ${editing ? '<aside class="notes-editor-pane notes-markdown-drawer" aria-label="Markdown editor"><div class="notes-cm-wrapper" id="notes-cm-editor"></div></aside>' : ''}
        </div>

        <app-action-bar fixed class="notes-action-bar" aria-label="Note status and actions">
          <div class="action-bar-left notes-footer-left">
            <span class="notes-type-label" title="${esc(note.slug ? `${note.slug}.md` : 'New note')}">
              <i class="fa-solid fa-${typeIcon(note.types)}" id="note-type-icon" aria-hidden="true"></i>
              ${editing
                ? `<input id="note-type" class="notes-type-input" placeholder="${DEFAULT_TYPE}" title="Note type; separate several with commas" aria-label="Note type" value="${esc((note.types || []).join(', '))}" spellcheck="false" />`
                : `<span class="notes-type-name">${esc((note.types || []).join(', ') || DEFAULT_TYPE)}</span>`}
            </span>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="notes-footer-stats" title="${chars.toLocaleString()} characters">
              <i class="fa-solid fa-align-left notes-stats-icon" aria-hidden="true"></i>
              <span class="stat-words"><span class="stat-value">${words.toLocaleString()}</span> words</span>
              <span class="stat-bullet" aria-hidden="true">•</span>
              <span class="stat-reading"><span class="stat-value">${readingMinutes}</span> min read</span>
            </div>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="action-bar-status notes-footer-status">
              <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
                <i class="fa-regular fa-clock" aria-hidden="true"></i>
                <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
              </span>
            </div>
            <span class="action-bar-divider notes-footer-divider notes-footer-tags-divider" aria-hidden="true"${hideTags ? ' hidden' : ''}></span>
            <label class="notes-footer-tags"${hideTags ? ' hidden' : ''}>
              <i class="fa-solid fa-tags" aria-hidden="true"></i>
              <input id="note-tags" class="notes-tags-input" placeholder="tags, comma separated" aria-label="Tags" value="${esc((note.tags || []).join(', '))}"${ro} />
            </label>
          </div>
          <div class="action-bar-right notes-footer-actions">
            <div class="map-toolbar" aria-label="Note actions">
              <button id="search-notes-btn" class="tool-button" type="button" title="Search notes (${searchShortcutKey})" aria-label="Search notes"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
              <span class="tool-divider" aria-hidden="true"></span>
              ${note.slug ? `
                <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>` : ''}
              <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
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
    this.querySelector('#delete-note-btn')?.addEventListener('click', () => this.confirmDeleteCurrentNote());
    this.querySelector('#edit-note-btn').addEventListener('click', () => this.setNoteEditing(!this.isNoteEditing));
    this.querySelector('#save-note-btn')?.addEventListener('click', () => this.saveCurrentNote());
    this.querySelector('#search-notes-btn').addEventListener('click', () => document.querySelector('note-spotlight')?.open());
    this.querySelector('#note-tags').addEventListener('input', () => this.markDirty());
    this.querySelector('#note-type')?.addEventListener('input', (event) => {
      this.querySelector('#note-type-icon').className = `fa-solid fa-${typeIcon(parseTags(event.target.value))}`;
      this.markDirty();
    });

    if (editing) this.initCodeMirror();
    this.setupPreviewEvents();
    this.refreshBacklinks();
  }

  // No page header: the browser tab carries the note's title.
  updateDocumentTitle() {
    document.title = `${this.selectedNote?.title || 'New note'} - Hive`;
  }

  updateSaveIndicator() {
    const button = this.querySelector('#save-note-btn');
    if (!button) return;
    button.className = `tool-button save ${this.saveStatus === 'dirty' ? 'dirty' : 'clean'}`;
    if (this.saveStatus === 'saving') {
      button.disabled = true;
      button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
      button.title = 'Saving note';
    } else {
      button.disabled = this.saveStatus !== 'dirty';
      button.title = 'Save note';
      button.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>';
    }
  }

  updateUpdatedStamp() {
    const stamp = this.querySelector('.stat-updated span');
    if (stamp && this.selectedNote?.updated) stamp.textContent = `Updated ${formatRelativeTime(this.selectedNote.updated)}`;
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
      const link = (note) => `<li><a href="/notes/${esc(encodeURIComponent(note.slug))}" data-route>${esc(note.title)}</a></li>`;
      const missing = data.unresolved.filter((target) => !target.startsWith('#'));
      container.className = data.backlinks.length || missing.length ? 'notes-backlinks' : '';
      container.innerHTML = `
        ${data.backlinks.length ? `<h4>Linked from (${data.backlinks.length})</h4><ul>${data.backlinks.map(link).join('')}</ul>` : ''}
        ${missing.length ? `<h4 style="margin-top:1rem">Broken links</h4><ul class="unresolved-list">${missing.map((target) => `<li><a href="#" data-create="${esc(target)}">${esc(target)}</a></li>`).join('')}</ul>` : ''}`;
      container.querySelectorAll('[data-create]').forEach((a) => a.addEventListener('click', (event) => {
        event.preventDefault();
        this.promptCreateNoteFromWikilink(a.dataset.create);
      }));
    } catch (error) {
      console.error('Failed to load backlinks:', error);
    }
  }

  /* --- Preview ------------------------------------------------------- */

  getTitleFromContent(content) {
    const heading = /^#\s+(.+)$/m.exec(String(content || ''));
    return heading ? heading[1].trim() : '';
  }

  renderMarkdownPreview(content) {
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
              if (!attribute.startsWith('#') && notesRouter.getMatch(url.pathname)) element.setAttribute('data-route', '');
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
    return parsed.body.innerHTML;
  }

  updateLivePreview(content) {
    const preview = this.querySelector('#notes-preview');
    const body = this.querySelector('#notes-md');
    if (!preview || !body) return;
    const scrollTop = preview.scrollTop;
    body.innerHTML = this.renderMarkdownPreview(content);
    this.setupPreviewEvents();
    preview.scrollTop = scrollTop;
  }

  setupPreviewEvents() {
    const preview = this.querySelector('#notes-preview');
    if (!preview) return;
    preview.removeEventListener('click', this._previewClickHandler);
    preview.addEventListener('click', this._previewClickHandler);
    this.decorateWikilinks(preview);
    this.setupCodeBlockActions(preview);
    this.preloadEditorWhenIdle();
  }

  // Fetch CodeMirror once the note has been shown, so the first switch to edit mode does not wait for it.
  preloadEditorWhenIdle() {
    if (editorModules || this._editorPreloadScheduled) return;
    this._editorPreloadScheduled = true;
    const preload = () => loadEditor().catch(() => {});
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preload, { timeout: 4000 });
    else setTimeout(preload, 2000);
  }

  setupCodeBlockActions(container) {
    container.querySelectorAll('pre code').forEach((block) => {
      const pre = block.parentElement;
      if (!pre || pre.querySelector('.notes-copy-code-btn')) return;
      const button = document.createElement('button');
      button.className = 'notes-copy-code-btn';
      button.type = 'button';
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML = '<i class="fa-regular fa-copy"></i>';
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await copyTextToClipboard(block.textContent || '');
          button.innerHTML = '<i class="fa-solid fa-check"></i>';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = '<i class="fa-regular fa-copy"></i>';
            button.classList.remove('copied');
          }, 1600);
        } catch (_error) { /* clipboard unavailable */ }
      });
      pre.appendChild(button);
    });
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

  /* --- CodeMirror ---------------------------------------------------- */

  destroyCodeMirror() {
    this._cmInitToken = null;
    if (this.cmEditor) {
      this.cmEditor.destroy();
      this.cmEditor = null;
    }
  }

  async initCodeMirror() {
    const container = this.querySelector('#notes-cm-editor');
    if (!container) return;
    this.destroyCodeMirror();
    const initToken = (this._cmInitToken = Symbol('codemirror'));
    let modules;
    try {
      modules = await loadEditor();
    } catch (error) {
      console.error('Could not load the editor', error);
      showToast('Could not load the editor. Reload the page and try again.', 'error');
      return;
    }
    // The note may have changed or the view been redrawn while the editor downloaded.
    if (this._cmInitToken !== initToken || !container.isConnected) return;

    this.cmEditor = modules.createEditor({
      doc: this.selectedNote?.content || '',
      language: modules.markdown({ codeLanguages: fencedCodeLanguage }),
      shortcuts: [{
        key: 'Mod-s',
        run: () => {
          if (this.selectedNote && this.saveStatus === 'dirty') this.saveCurrentNote();
          return true;
        },
      }],
      placeholder: 'Start writing markdown...',
      contentAttributes: { spellcheck: 'true', lang: 'en-US', autocorrect: 'on', autocapitalize: 'sentences' },
      onUpdate: (update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        this.selectedNote.content = text;
        this.updateLivePreview(text);
        this.updateStats();
        this.markDirty();
      },
      // The action bar overlays the bottom of the editor; the content's bottom padding is its height.
      scrollMargins: (view) => ({ bottom: parseFloat(getComputedStyle(view.contentDOM).paddingBottom) || 0 }),
      parent: container,
      root: document,
    });
    if (!this.selectedNote?.slug) this.cmEditor.dispatch({ selection: { anchor: 2 } }); // new note: type the title
    if (this._focusEditorWhenReady) this.focusEditor();
  }

  focusEditor() {
    if (this.cmEditor) {
      this._focusEditorWhenReady = false;
      this.cmEditor.focus();
    } else {
      this._focusEditorWhenReady = true;
    }
  }

  updateStats() {
    const text = this.currentContent();
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const readingMinutes = words ? Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE)) : 0;
    const wordsEl = this.querySelector('.stat-words .stat-value');
    const readingEl = this.querySelector('.stat-reading .stat-value');
    if (wordsEl) wordsEl.textContent = words.toLocaleString();
    if (readingEl) readingEl.textContent = readingMinutes;
    const stats = this.querySelector('.notes-footer-stats');
    if (stats) stats.title = `${text.length.toLocaleString()} characters`;
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

  /* --- History (git) ------------------------------------------------- */

  async openNoteVersions() {
    const note = this.selectedNote;
    if (!note?.slug) return;
    const base = `/notes/${encodeURIComponent(note.slug)}`;
    const { dialog, close } = openDialog(`
      <div class="modal-header">
        <h2 class="modal-title">History</h2>
        <div class="note-versions-header-actions">
          <button type="button" class="crud-drawer-btn" id="version-back" hidden><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> <span>All Versions</span></button>
          <button type="button" class="crud-drawer-btn primary" id="version-restore" hidden><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> <span>Restore this version</span></button>
          <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="modal-body">
        <p class="note-version-message" role="status" aria-live="polite"></p>
        <div class="hive-version-list" id="version-list" aria-live="polite"></div>
        <div id="version-detail" hidden></div>
      </div>`, { wide: true, className: 'note-versions-dialog-host' });
    const list = dialog.querySelector('#version-list');
    const detail = dialog.querySelector('#version-detail');
    const message = dialog.querySelector('.note-version-message');
    const back = dialog.querySelector('#version-back');
    const restore = dialog.querySelector('#version-restore');

    const showList = () => {
      detail.hidden = true;
      back.hidden = true;
      restore.hidden = true;
      list.hidden = false;
      message.textContent = '';
    };
    back.addEventListener('click', showList);

    const renderDiff = (text) => (text.trim()
      ? text.split('\n').map((line) => {
        const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '';
        return `<span class="${cls}">${esc(line)}</span>`;
      }).join('\n')
      : '<span class="hunk">No changes to the note body in this version.</span>');

    try {
      const versions = await api(`${base}/versions`);
      list.innerHTML = versions.map((version) => `
        <button type="button" class="hive-version-row" data-sha="${esc(version.sha)}">
          <span class="msg">${esc(version.message)}</span>
          <span>${esc(version.author)}</span>
          <time datetime="${esc(version.committed_at)}" title="${esc(parseUtcDate(version.committed_at)?.toLocaleString() || '')}">${esc(formatRelativeTime(version.committed_at))}</time>
        </button>`).join('') || '<p>No history yet.</p>';
    } catch (error) {
      list.innerHTML = `<p class="note-version-message error">${esc(error.message)}</p>`;
      return;
    }

    list.addEventListener('click', async (event) => {
      const row = event.target.closest('.hive-version-row');
      if (!row) return;
      try {
        const sha = row.dataset.sha;
        const { diff } = await api(`${base}/versions/${sha}/diff`);
        list.hidden = true;
        detail.hidden = false;
        back.hidden = false;
        restore.hidden = false;
        detail.innerHTML = `<p style="margin-bottom:.5rem">${esc(row.querySelector('.msg').textContent)} · <code>${esc(sha.slice(0, 7))}</code></p><pre class="hive-diff">${renderDiff(diff)}</pre>`;
        restore.onclick = async () => {
          const confirmed = await confirmDialog({
            title: 'Restore this version?',
            message: 'The note is set back to this version and saved as a new commit. Newer history is kept.',
            confirmText: 'Restore',
            cancelText: 'Cancel',
          });
          if (!confirmed) return;
          try {
            // The restored title can differ from the current one, in which case the file gets its old name back.
            const restored = await api(`${base}/versions/${sha}/restore`, { method: 'POST' });
            close();
            this.saveStatus = 'saved';
            this.destroyCodeMirror();
            showToast('Version restored', 'success');
            this.selectedSlug = restored.slug;
            notesRouter.navigate(`/notes/${encodeURIComponent(restored.slug)}${this.isNoteEditing ? '?mode=edit' : ''}`, { replace: true });
            this.loadEditorNote(restored.slug, { startInEdit: this.isNoteEditing });
          } catch (error) {
            message.className = 'note-version-message error';
            message.textContent = error.message;
          }
        };
      } catch (error) {
        message.className = 'note-version-message error';
        message.textContent = error.message || 'Could not open version.';
      }
    });
  }
}

customElements.define('notes-app', NotesApp);

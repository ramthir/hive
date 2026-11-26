import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { api } from '/static/notes/api.js';
import { debounce, remoteAction, watchChanges } from '/static/events.js';
import { notesRouter } from '/static/notes/notes-router.js';

/**
 * Fetch the latest copy of `slug` after an SSE change event and dispatch `'apply'`, `'banner'`, or `'gone'`
 * while respecting in-flight saves and active chat runs.
 */
export async function pollRemoteNote({
  slug, heldRevision, isCurrent, isSaving, isUnsaved, holdsNote, onRetry, onGone, onBanner, onApply,
}) {
  if (!isCurrent()) return;
  if (isSaving()) { onRetry(); return; }
  let fresh = null;
  try {
    fresh = await api(`/notes/${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error.status !== 404) return; // the server is not reachable: the stream reconnects and asks again
  }
  if (!isCurrent()) return;
  if (isSaving()) { onRetry(); return; }
  const action = remoteAction({ heldRevision: heldRevision(), fresh, unsaved: isUnsaved() });
  if (action === 'none') return;
  if (action === 'gone') {
    if (holdsNote(slug)) return; // the chat is renaming it: it tells us when its run ends (chatFinished)
    onGone();
    return;
  }
  if (action === 'banner') { onBanner(fresh); return; }
  onApply(fresh);
}

// Changes made elsewhere (another tab, an editor, git pull).
export class RemoteChanges {
  // Listen for the open note only. An event says "look again": the note is fetched and its revision compared with the
  // one this page holds, so the page's own saves (which update the revision) are recognised and nothing flickers.
  watchNote(slug) {
    if (this._watchedSlug === slug && this._changes) return;
    this.stopWatching();
    this._watchedSlug = slug;
    this._checkRemote = debounce(() => this.checkRemoteChange(slug), 400);
    this._changes = watchChanges({ note: slug }, this._checkRemote);
  }

  stopWatching() {
    this._changes?.close();
    this._checkRemote?.cancel();
    this._changes = this._checkRemote = this._watchedSlug = null;
    this.querySelector('.notes-remote-banner')?.remove();
  }

  async checkRemoteChange(slug) {
    await pollRemoteNote({
      slug,
      heldRevision: () => this.selectedNote.revision,
      isCurrent: () => this.selectedSlug === slug && Boolean(this.selectedNote),
      isSaving: () => this.saveStatus === 'saving',
      isUnsaved: () => this.saveStatus === 'dirty',
      holdsNote: (s) => this.chatDock.holdsNote(s),
      onRetry: () => this._checkRemote(),
      onGone: () => {
        if (this.saveStatus === 'dirty') {
          this.showRemoteBanner('This note was deleted or renamed outside this page. Your unsaved text is still here; saving writes it back.');
          return;
        }
        showToast('This note was renamed or deleted elsewhere.', 'info');
        notesRouter.navigate('/notes', { replace: true });
      },
      onBanner: (fresh) => this.showRemoteBanner('This note changed outside this page. Reloading discards your unsaved edits.', fresh),
      onApply: (fresh) => this.applyRemoteNote(fresh),
    });
  }

  // Show the note as it is now, keeping the reading position and edit mode.
  applyRemoteNote(fresh) {
    const preview = this.querySelector('#notes-preview');
    const scrollTop = preview?.scrollTop ?? 0;
    // The editor is rebuilt with the new text: remember where the caret and the editor's scroll were.
    this._restoreEditorView = this.cmEditor
      ? { head: this.cmEditor.state.selection.main.head, scrollTop: this.cmEditor.scrollDOM.scrollTop }
      : null;
    this.selectedNote = fresh;
    this.saveStatus = 'saved';
    this.destroyCodeMirror();
    this.renderEditorView();
    const again = this.querySelector('#notes-preview');
    if (again) again.scrollTop = scrollTop;
    if (this.isNoteEditing) setTimeout(() => this.focusEditor(), 0);
  }

  // Put the caret and scroll of the editor that was replaced into the new one (the text may be shorter now).
  restoreEditorView() {
    const saved = this._restoreEditorView;
    this._restoreEditorView = null;
    if (!saved || !this.cmEditor) return;
    const head = Math.min(saved.head, this.cmEditor.state.doc.length);
    this.cmEditor.dispatch({ selection: { anchor: head } });
    // Focusing the editor scrolls the caret into view, which may be far from where the reader was: put the scroll back after it.
    const scroll = () => { if (this.cmEditor) this.cmEditor.scrollDOM.scrollTop = saved.scrollTop; };
    requestAnimationFrame(scroll);
    setTimeout(scroll, 100);
  }

  showRemoteBanner(message, fresh = null) {
    this.querySelector('.notes-remote-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = 'notes-remote-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${esc(message)}</span>${fresh ? '<button type="button" class="crud-drawer-btn" data-remote="reload">Reload</button>' : ''}<button type="button" class="crud-drawer-btn" data-remote="dismiss">Keep editing</button>`;
    banner.addEventListener('click', (event) => {
      const action = event.target.closest('[data-remote]')?.dataset.remote;
      if (!action) return;
      banner.remove();
      if (action === 'reload') this.applyRemoteNote(fresh);
    });
    (this.querySelector('.notes-editor-page') || this).prepend(banner);
  }
}

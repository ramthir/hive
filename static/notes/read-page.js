import { confirmDialog } from '/static/components/dialog.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { typeIcon, typeLabel } from '/static/type-icons.js';
import { api } from '/static/notes/api.js';
import { openVersionHistory } from '/static/notes/history.js';
import { openProperties } from '/static/notes/properties.js';
import { READ_PAGES } from '/static/notes/read-pages.js';
import { debounce, remoteAction, watchChanges } from '/static/events.js';
import { NoteChatDock } from '/static/notes/note-chat.js';

/* The page behind /tables/{slug}, /timelines/{slug}...: load the note, send it to /notes/{slug} when it is not of this
   type (or does not exist), draw it with `View`, and run the footer buttons. The pencil goes to /notes/{slug}?mode=edit.
   `viewOptions(app)` adds callbacks only one view has; `onSaved(app, saved)` runs after the properties drawer saves.

   The page follows its note: an event from the server (`GET /api/events?note=`) fetches the note and compares its `revision` with the one
   held, so the page's own saves are recognised; a changed note is drawn again (the view keeps its filter, sort and page). A view may have
   `busy()` ('saving' while its own save is out, 'editing' while a drawer is open): the page waits for a save, and for an open drawer
   (it would be thrown away) says so and draws the change once the drawer is closed. The chat beside the note is the shared `NoteChatDock`;
   the view's footer carries its button (`actions.chat`, `actions.chatOpen`). */

const notePath = (slug, query = '') => `/notes/${encodeURIComponent(slug)}${query}`;

export function defineReadPage({ tag, type, View, viewOptions = () => ({}), onSaved = () => {} }) {
  const { path, matches } = READ_PAGES.find((page) => page.type === type);
  const pathPrefix = new RegExp(`^${path}/?`);

  class ReadPage extends HTMLElement {
    connectedCallback() {
      this.slug = decodeURIComponent(window.location.pathname.replace(pathPrefix, '').split('/')[0] || '');
      this.chat = new NoteChatDock(this, {
        note: () => this.note,
        onFinished: (detail) => this.chatFinished(detail),
        onNavigate: (href) => window.location.assign(href),
        onHistory: () => this.versions(),
      });
      this.view = new View(this, {
        edit: () => window.location.assign(notePath(this.slug, '?mode=edit')),
        copy: () => this.copy(),
        delete: () => this.remove(),
        properties: () => this.properties(),
        versions: () => this.versions(),
        chat: () => this.chat.toggle(),
        chatOpen: () => this.chat.open,
        ...viewOptions(this),
      });
      this.chat.attach();
      this.load();
      if (this.slug) {
        this.refresh = debounce(() => this.checkRemote(), 400);
        this.changes = watchChanges({ note: this.slug }, this.refresh);
      }
    }

    disconnectedCallback() {
      this.changes?.close();
      this.refresh?.cancel();
      clearTimeout(this._holdTimer);
      this.chat?.detach();
      this.view?.destroy?.();
    }

    versions() {
      return openVersionHistory(this.slug, { onRestored: () => this.load() });
    }

    draw(note) {
      this.note = note;
      document.title = `${note.title} - Hive`;
      this.view.render(note, { typeLabel: typeLabel(type), typeIconName: typeIcon(type) });
      this.chat.mount();
    }

    // The note changed (the chat, another tab, an editor, git): look again, and draw it if the text really differs from what is held.
    async checkRemote() {
      if (!this.note || !this.slug) return;
      if (this.view.busy?.() === 'saving') { this.refresh(); return; } // our own save is out: its answer updates the page
      let fresh = null;
      try {
        fresh = await api(`/notes/${encodeURIComponent(this.slug)}`);
      } catch (error) {
        if (error.status !== 404) return; // the server is not reachable: the stream reconnects and asks again
      }
      if (this.view.busy?.() === 'saving') { this.refresh(); return; }
      const action = remoteAction({ heldRevision: this.note.revision, fresh, unsaved: Boolean(this.view.busy?.()) });
      if (action === 'none') return;
      if (action === 'gone') {
        if (this.chat.holdsNote(this.slug)) return; // the chat is renaming it: it tells us when its run ends (chatFinished)
        showToast('This note was renamed or deleted elsewhere.', 'info');
        window.location.replace('/notes');
        return;
      }
      if (!matches(fresh)) { window.location.replace(notePath(this.slug)); return; } // no longer this type: the note page
      if (action === 'banner') { this.holdForDrawer(); return; }
      this._heldToast = false;
      this.draw(fresh);
    }

    // A row is open in the drawer (a modal, so a banner behind it could not be reached): say so once and look again until it is closed.
    holdForDrawer() {
      if (!this._heldToast) showToast('This note changed elsewhere. The page refreshes when you close the row.', 'info');
      this._heldToast = true;
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this.checkRemote(), 1000);
    }

    // The chat's run ended. If it renamed this note (a new heading), go to the new file; otherwise look again at what was held back.
    chatFinished({ renamed }) {
      if (renamed && renamed.from === this.slug) window.location.replace(notePath(renamed.slug));
      else this.checkRemote();
    }

    async load() {
      if (!this.slug) return window.location.replace('/notes');
      try {
        const note = await api(`/notes/${encodeURIComponent(this.slug)}`);
        if (!matches(note)) return window.location.replace(notePath(this.slug)); // not this type: the note page
        this.draw(note);
      } catch (error) {
        if (error.status === 404) return window.location.replace('/notes');
        console.error(`Failed to load ${type}:`, error);
        showToast(error.message || `Could not load ${type}.`, 'error');
      }
    }

    async copy() {
      try {
        await copyTextToClipboard(this.note.content);
        showToast('Copied markdown', 'success');
      } catch (error) {
        console.error('Failed to copy note:', error);
      }
    }

    async remove() {
      const confirmed = await confirmDialog({
        title: 'Delete Note?',
        message: `Delete "${this.note.title}"? The file is removed and the deletion is committed; you can recover it from git history.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/notes/${encodeURIComponent(this.slug)}`, { method: 'DELETE' });
        window.location.assign('/notes');
      } catch (error) {
        showToast(error.message || 'Could not delete note.', 'error');
      }
    }

    async properties() {
      await openProperties(this.note, {
        onSaved: (saved) => {
          this.note = saved;
          onSaved(this, saved);
          showToast(`Properties saved · ${saved.title}`, 'success');
          if (!matches(saved)) window.location.replace(notePath(saved.slug));
        },
      });
    }
  }

  customElements.define(tag, ReadPage);
  return ReadPage;
}

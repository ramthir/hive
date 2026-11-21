import { confirmDialog } from '/static/components/dialog.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { typeIcon, typeLabel } from '/static/type-icons.js';
import { api } from '/static/notes/api.js';
import { openVersionHistory } from '/static/notes/history.js';
import { openProperties } from '/static/notes/properties.js';
import { READ_PAGES } from '/static/notes/read-pages.js';

/* The page behind /tables/{slug}, /timelines/{slug}...: load the note, send it to /notes/{slug} when it is not of this
   type (or does not exist), draw it with `View`, and run the footer buttons. The pencil goes to /notes/{slug}?mode=edit.
   `viewOptions(app)` adds callbacks only one view has; `onSaved(app, saved)` runs after the properties drawer saves. */

const notePath = (slug, query = '') => `/notes/${encodeURIComponent(slug)}${query}`;

export function defineReadPage({ tag, type, View, viewOptions = () => ({}), onSaved = () => {} }) {
  const { path, matches } = READ_PAGES.find((page) => page.type === type);
  const pathPrefix = new RegExp(`^${path}/?`);

  class ReadPage extends HTMLElement {
    connectedCallback() {
      this.slug = decodeURIComponent(window.location.pathname.replace(pathPrefix, '').split('/')[0] || '');
      this.view = new View(this, {
        edit: () => window.location.assign(notePath(this.slug, '?mode=edit')),
        copy: () => this.copy(),
        delete: () => this.remove(),
        properties: () => this.properties(),
        versions: () => openVersionHistory(this.slug, { onRestored: () => this.load() }),
        ...viewOptions(this),
      });
      this.load();
    }

    disconnectedCallback() {
      this.view?.destroy?.();
    }

    async load() {
      if (!this.slug) return window.location.replace('/notes');
      try {
        const note = await api(`/notes/${encodeURIComponent(this.slug)}`);
        if (!matches(note)) return window.location.replace(notePath(this.slug)); // not this type: the note page
        this.note = note;
        document.title = `${note.title} - Hive`;
        this.view.render(note, { typeLabel: typeLabel(type), typeIconName: typeIcon(type) });
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

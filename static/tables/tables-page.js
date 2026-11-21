import { confirmDialog } from '/static/components/dialog.js';
import { SPOTLIGHT_SELECT_EVENT } from '/static/components/note-spotlight.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { showToast } from '/static/toast.js';
import { typeIcon, typeLabel } from '/static/type-icons.js';
import { api } from '/static/notes/api.js';
import { openVersionHistory } from '/static/notes/history.js';
import { openProperties } from '/static/notes/properties.js';
import { updateUpdatedStamp } from '/static/notes/status-bar.js';
import { isTableNote } from '/static/tables/table-note.js';
import { TableView } from '/static/tables/table-view.js';

/* /tables/{slug}: a note of type table as a table. Other notes are sent to /notes/{slug}; the pencil goes there too. */

const notePath = (slug, query = '') => `/notes/${encodeURIComponent(slug)}${query}`;

class TablesApp extends HTMLElement {
  connectedCallback() {
    this.slug = decodeURIComponent(window.location.pathname.replace(/^\/tables\/?/, '').split('/')[0] || '');
    this.view = new TableView(this, {
      go: (path) => window.location.assign(path),
      edit: () => window.location.assign(notePath(this.slug, '?mode=edit')),
      copy: () => this.copy(),
      delete: () => this.remove(),
      properties: () => this.properties(),
      versions: () => openVersionHistory(this.slug, { onRestored: () => this.load() }),
      saved: (saved) => {
        this.note = saved;
        updateUpdatedStamp(this, saved);
      },
    });
    this._spotlight = (event) => window.location.assign(notePath(event.detail.slug));
    window.addEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener(SPOTLIGHT_SELECT_EVENT, this._spotlight);
    this.view?.destroy();
  }

  async load() {
    if (!this.slug) return window.location.replace('/notes');
    try {
      const note = await api(`/notes/${encodeURIComponent(this.slug)}`);
      if (!isTableNote(note)) return window.location.replace(notePath(this.slug)); // not a table: the note page
      this.note = note;
      document.title = `${note.title} - Hive`;
      this.view.render(note, { typeLabel: typeLabel('table'), typeIconName: typeIcon('table') });
    } catch (error) {
      if (error.status === 404) return window.location.replace('/notes');
      console.error('Failed to load table:', error);
      showToast(error.message || 'Could not load table.', 'error');
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
        updateUpdatedStamp(this, saved);
        showToast(`Properties saved · ${saved.title}`, 'success');
        if (!isTableNote(saved)) window.location.replace(notePath(saved.slug));
      },
    });
  }
}

customElements.define('tables-app', TablesApp);

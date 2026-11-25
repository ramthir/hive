import { noteTypeIcon, noteTypeColor } from '../type-icons.js';
import { readPagePath } from '../notes/read-pages.js';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function formatSpotlightNote(note) {
  return {
    slug: note?.slug,
    types: Array.isArray(note?.types) ? note.types : [],
    title: String(note?.title || '').trim() || String(note?.slug || 'Untitled'),
    role: String(note?.role || '').trim(),
    tags: Array.isArray(note?.tags) ? note.tags : [],
    updated: note?.updated || '',
  };
}

/** Spotlight asks the page to navigate instead of reloading, so unsaved edits can be guarded. */
export const SPOTLIGHT_SELECT_EVENT = 'note-spotlight-select';

if (typeof HTMLElement !== 'undefined' && !customElements.get('note-spotlight')) {
  class NoteSpotlight extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._open = false;
      this._items = [];
      this._activeIndex = 0;
      this._timer = null;
      this._controller = null;
      this._previousFocus = null;
      this._onGlobalKeydown = this._handleGlobalKeydown.bind(this);
    }

    connectedCallback() {
      this._render();
      document.addEventListener('keydown', this._onGlobalKeydown, true);
    }

    disconnectedCallback() {
      document.removeEventListener('keydown', this._onGlobalKeydown, true);
      clearTimeout(this._timer);
      this._controller?.abort();
    }

    /** `query` pre-fills the search (a tag chip opens it with the tag). */
    open(query = '') {
      if (this._open) return;
      this._previousFocus = document.activeElement;
      this._open = true;
      const backdrop = this.shadowRoot.querySelector('.spotlight-backdrop');
      const input = this.shadowRoot.querySelector('.spotlight-input');
      const clearBtn = this.shadowRoot.querySelector('.spotlight-clear-btn');
      if (backdrop) backdrop.hidden = false;
      if (clearBtn) clearBtn.hidden = !query;
      if (input) {
        input.value = query;
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
      }
      this._fetchNotes(query);
    }

    close() {
      if (!this._open) return;
      this._open = false;
      clearTimeout(this._timer);
      this._controller?.abort();
      const backdrop = this.shadowRoot.querySelector('.spotlight-backdrop');
      if (backdrop) backdrop.hidden = true;
      const prev = this._previousFocus;
      this._previousFocus = null;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    }

    toggle() {
      if (this._open) this.close();
      else this.open();
    }

    _handleGlobalKeydown(event) {
      const isCmdK = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    }

    async _fetchNotes(query) {
      this._controller?.abort();
      const controller = new AbortController();
      this._controller = controller;
      const trimmed = String(query || '').trim();
      // Ranked search over title, tags and content; with no query, the notes edited most recently.
      const url = trimmed
        ? `/api/notes?q=${encodeURIComponent(trimmed)}&limit=10`
        : '/api/notes?sort=recent&limit=10';
      try {
        const res = await fetch(url, { signal: controller.signal });
        const notes = res.ok ? await res.json() : [];
        if (controller.signal.aborted) return;
        this._items = Array.isArray(notes) ? notes.map(formatSpotlightNote).filter((item) => item.slug) : [];
        this._activeIndex = 0;
        this._renderResults(trimmed);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        this._items = [];
        this._activeIndex = 0;
        this._renderResults(trimmed);
      }
    }

    _navigateTo(note) {
      if (!note?.slug) return;
      this.close();
      const path = readPagePath(note) || `/notes/${encodeURIComponent(note.slug)}`;
      // A page that handles the selection itself (in-place navigation) calls preventDefault();
      // on every other page we go straight to the note (or its dedicated read page).
      const event = new CustomEvent(SPOTLIGHT_SELECT_EVENT, { detail: { slug: note.slug, types: note.types, path }, cancelable: true });
      window.dispatchEvent(event);
      if (!event.defaultPrevented) window.location.assign(path);
    }

    _moveSelection(delta) {
      if (!this._items.length) return;
      this._activeIndex = (this._activeIndex + delta + this._items.length) % this._items.length;
      const list = this.shadowRoot.querySelector('.spotlight-results');
      if (!list) return;
      const rows = list.querySelectorAll('.spotlight-item');
      rows.forEach((row, index) => {
        const active = index === this._activeIndex;
        row.classList.toggle('active', active);
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) row.scrollIntoView({ block: 'nearest' });
      });
    }

    _renderResults(query) {
      const list = this.shadowRoot.querySelector('.spotlight-results');
      if (!list) return;
      if (!this._items.length) {
        list.innerHTML = `<div class="spotlight-empty">${query ? 'No matching notes found.' : 'No notes yet.'}</div>`;
        return;
      }
      list.innerHTML = this._items
        .map((item, index) => {
          const active = index === this._activeIndex;
          return `<button type="button" class="spotlight-item${active ? ' active' : ''}" role="option" aria-selected="${active ? 'true' : 'false'}" data-index="${index}">
            <span class="spotlight-item-icon" style="${noteTypeColor(item.types) ? `color: ${noteTypeColor(item.types)}` : ''}" title="${escapeHtml(item.types.join(', ') || 'note')}"><i class="fa-solid fa-${escapeHtml(noteTypeIcon(item.types))}" aria-hidden="true"></i></span>
            <span class="spotlight-item-title">${escapeHtml(item.title)}${item.role ? `<span class="spotlight-role">${escapeHtml(item.role)}</span>` : ''}</span>
            <span class="spotlight-item-meta">
              ${item.tags.slice(0, 3).map((tag) => `<span class="spotlight-tag">#${escapeHtml(tag)}</span>`).join('')}
              <span class="spotlight-id">${escapeHtml(item.updated)}</span>
            </span>
          </button>`;
        })
        .join('');
    }

    _render() {
      this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="/static/vendor/fontawesome/css/all.min.css">
        <style>
          :host, :host *, :host *::before, :host *::after {
            box-sizing: border-box;
          }
          .spotlight-backdrop[hidden] {
            display: none;
          }
          .spotlight-backdrop {
            --spotlight-top-gap: 12vh;
            --spotlight-bottom-gap: 2rem;
            position: fixed;
            inset: 0;
            z-index: 2000;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: var(--spotlight-top-gap) 1rem var(--spotlight-bottom-gap);
            background: rgba(0, 0, 0, 0.65);
            backdrop-filter: blur(var(--dialog-overlay-blur));
            -webkit-backdrop-filter: blur(var(--dialog-overlay-blur));
          }
          .spotlight-panel {
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            width: min(52rem, 100%);
            max-height: calc(100vh - var(--spotlight-top-gap) - var(--spotlight-bottom-gap));
            background: var(--color-dark1);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-xl);
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
            overflow: hidden;
            color: var(--color-text);
            font-family: var(--font-family);
          }
          .spotlight-header {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: var(--space-3, 0.75rem);
            padding: 0.875rem 1rem;
            border-bottom: 1px solid var(--color-border);
          }
          .spotlight-search-icon {
            color: var(--color-dimmed2);
            font-size: 0.95rem;
            flex-shrink: 0;
          }
          .spotlight-input {
            flex: 1;
            min-width: 0;
            border: 0;
            background: transparent;
            color: var(--color-text);
            font: 500 1rem/1.4 var(--font-family);
            outline: none;
          }
          .spotlight-input::placeholder {
            color: var(--color-dimmed2);
          }
          .spotlight-input::-webkit-search-cancel-button {
            -webkit-appearance: none;
            appearance: none;
            display: none;
          }
          .spotlight-clear-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 1.5rem;
            height: 1.5rem;
            padding: 0;
            border: 0;
            border-radius: 50%;
            background: transparent;
            color: var(--color-dimmed2);
            cursor: pointer;
            flex-shrink: 0;
            transition: color 0.15s ease, background-color 0.15s ease;
          }
          .spotlight-clear-btn:hover {
            color: var(--search-clear-hover-color, var(--color-danger));
            background: var(--search-clear-hover-bg);
          }
          .spotlight-clear-btn[hidden] {
            display: none;
          }
          .spotlight-esc {
            padding: 0.15rem 0.45rem;
            border-radius: var(--radius-sm);
            border: 1px solid var(--color-border);
            background: var(--color-dark2);
            color: var(--color-dimmed2);
            font: 600 0.7rem/1.2 var(--font-family);
            flex-shrink: 0;
          }
          .spotlight-results {
            overflow-y: auto;
            padding: 0.375rem;
          }
          .spotlight-empty {
            padding: 1.5rem 1rem;
            text-align: center;
            color: var(--color-dimmed2);
            font-size: 0.875rem;
          }
          .spotlight-item {
            width: 100%;
            display: flex;
            align-items: center;
            gap: var(--space-3, 0.75rem);
            padding: 0.6rem 0.75rem;
            border: 0;
            border-radius: var(--radius-md);
            background: transparent;
            color: inherit;
            text-align: left;
            cursor: pointer;
            font: inherit;
          }
          .spotlight-item:hover,
          .spotlight-item.active {
            background: var(--color-option-hover-bg);
          }
          .spotlight-item-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 0.9rem;
            font-weight: 500;
          }
          .spotlight-item-meta {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
          }
          .spotlight-item-icon {
            color: var(--color-dimmed2);
            flex-shrink: 0;
            width: 1.25rem;
            text-align: center;
          }
          .spotlight-role {
            margin-left: 0.6rem;
            color: var(--color-dimmed2);
            font-size: 0.78rem;
            font-weight: 400;
          }
          .spotlight-tag {
            color: var(--color-dimmed2);
            font-size: 0.75rem;
          }
          .spotlight-id {
            color: var(--color-dimmed2);
            font-size: 0.75rem;
            font-variant-numeric: tabular-nums;
          }
        </style>
        <div class="spotlight-backdrop" hidden>
          <div class="spotlight-panel" role="dialog" aria-modal="true" aria-label="Search notes">
            <div class="spotlight-header">
              <i class="fa-solid fa-magnifying-glass spotlight-search-icon" aria-hidden="true"></i>
              <input class="spotlight-input" type="search" autocomplete="off" placeholder="Search notes by title, tag or content…" aria-label="Search notes" />
              <button type="button" class="spotlight-clear-btn" aria-label="Clear search" hidden><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
              <kbd class="spotlight-esc">Esc</kbd>
            </div>
            <div class="spotlight-results" role="listbox" aria-label="Matching notes"></div>
          </div>
        </div>
      `;

      const backdrop = this.shadowRoot.querySelector('.spotlight-backdrop');
      const input = this.shadowRoot.querySelector('.spotlight-input');
      const clearBtn = this.shadowRoot.querySelector('.spotlight-clear-btn');
      const results = this.shadowRoot.querySelector('.spotlight-results');

      backdrop?.addEventListener('click', (event) => {
        if (event.target === backdrop) this.close();
      });

      input?.addEventListener('input', () => {
        clearTimeout(this._timer);
        const query = input.value;
        if (clearBtn) clearBtn.hidden = !query;
        this._timer = setTimeout(() => this._fetchNotes(query), 120);
      });

      clearBtn?.addEventListener('click', () => {
        if (!input) return;
        input.value = '';
        clearBtn.hidden = true;
        clearTimeout(this._timer);
        this._fetchNotes('');
        input.focus();
      });

      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          this._moveSelection(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          this._moveSelection(-1);
        } else if (event.key === 'Enter') {
          const item = this._items[this._activeIndex];
          if (item) {
            event.preventDefault();
            this._navigateTo(item);
          }
        }
      });

      results?.addEventListener('click', (event) => {
        const btn = event.target.closest('.spotlight-item');
        if (!btn) return;
        const item = this._items[Number(btn.dataset.index)];
        this._navigateTo(item);
      });
    }
  }

  customElements.define('note-spotlight', NoteSpotlight);

  if (typeof document !== 'undefined') {
    const mount = () => {
      if (!document.querySelector('note-spotlight')) {
        document.body?.appendChild(document.createElement('note-spotlight'));
      }
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
}

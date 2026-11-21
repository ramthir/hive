import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/relative-time.js';
import { showToast } from '/static/toast.js';
import { api } from '/static/notes/api.js';
import { renderFilterField } from '/static/components/search-trigger.js';
import '/static/components/stat-card.js';
import { renderStatCard } from '/static/components/stat-card-render.js';
import { createCrudDrawer } from '/static/components/crud-drawer.js';
import '/static/components/table.js';
import '/static/components/pagination.js';
import '/static/components/combobox.js';
import {
  isTableNote, parseMarkdownTableNote, serializeMarkdownTableNote, extractWikilinkTargets, formatCellValueForEdit,
  resolveCellSegments, resolveCellDisplay, filterTableRows, sortTableRows, parseTableStatsConfig, evaluateTableStats,
} from '/static/tables/table-note.js';

const PAGE_SIZE = 15;
const RESOLVE_CHUNK = 40;


/**
 * The table view of a note: the first markdown table in the text as rows you can filter, sort, page, add, edit and
 * delete. Every change rewrites that table in the note's markdown and saves it (one git commit); the rest of the text is
 * kept as it is. `host` is the page element; `actions` are its handlers for the footer buttons.
 */
export class TableView {
  constructor(host, actions) {
    this.host = host;
    this.actions = actions;
    this.slug = null;
    this.query = '';
    this.page = 0;
    this.sort = null;
    this.titles = new Map(); // wikilink target -> title of the note it names
    this.slugs = new Map(); // wikilink target -> file name
    this.people = []; // combobox choices for the linked columns: notes of type contact
    this.drawer = null;
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    this.drawer?.destroy();
    this.drawer = null;
  }

  render(note, { typeLabel, typeIconName }) {
    this.destroy();
    if (this.slug !== note.slug) {
      this.slug = note.slug;
      this.query = '';
      this.page = 0;
      this.sort = null;
    }
    this.note = note;
    this.parsed = parseMarkdownTableNote(note.content);
    const hasColumns = this.parsed.columns.length > 0;
    const { host } = this;
    host.innerHTML = `
      <section class="notes-page notes-table-page">
        <app-header heading="${esc(note.title)}" variant="flush" attached>
          <div slot="actions" class="notes-header-actions app-header-action-group">
            ${renderFilterField({ placeholder: 'Filter rows…', value: this.query, label: 'Filter rows', inputClass: 'notes-table-filter', shortcut: '/' })}
            <button id="add-table-row-btn" class="primary" type="button" title="Add a new row"${hasColumns ? '' : ' disabled'}><i class="fa-solid fa-plus" aria-hidden="true"></i> Add row</button>
          </div>
        </app-header>
        <div class="notes-table-workspace">
          <div class="stat-card-grid table-stats-grid" id="notes-table-stats-grid" hidden></div>
          <div class="table-card notes-table-card"><app-table id="notes-data-table" sort-mode="server" clickable-rows aria-label="${esc(note.title)}"></app-table></div>
          <app-pagination id="notes-table-pagination" class="notes-table-pagination" hidden></app-pagination>
          <div id="notes-table-drawer-host"></div>
        </div>
        <app-action-bar fixed class="notes-action-bar" aria-label="Table status and actions">
          <div class="action-bar-left notes-footer-left">
            <span class="notes-type-label"><i class="fa-solid fa-${esc(typeIconName)}" aria-hidden="true"></i><span>${esc(typeLabel)}</span></span>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="notes-footer-stats"><span class="stat-words"><span class="stat-value" id="notes-table-row-count">${this.parsed.rows.length.toLocaleString()}</span> rows</span></div>
            <span class="action-bar-divider notes-footer-divider" aria-hidden="true"></span>
            <div class="action-bar-status notes-footer-status">
              <span class="stat-updated" title="${esc(parseUtcDate(note.updated)?.toLocaleDateString() || '')}">
                <i class="fa-regular fa-clock" aria-hidden="true"></i>
                <span>${note.updated ? `Updated ${esc(formatRelativeTime(note.updated))}` : 'Draft'}</span>
              </span>
            </div>
          </div>
          <div class="action-bar-right notes-footer-actions">
            <div class="map-toolbar" aria-label="Table actions">
              <button id="delete-note-btn" class="tool-button danger" type="button" aria-label="Delete note" title="Delete note"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
              <button id="copy-note-btn" class="tool-button" type="button" title="Copy note markdown to clipboard" aria-label="Copy note markdown to clipboard"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
              ${note.has_properties ? '<button id="note-properties-btn" class="tool-button" type="button" title="Edit note properties" aria-label="Edit note properties"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>' : ''}
              <button id="note-versions-btn" class="tool-button" type="button" title="History" aria-label="History"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>
              <button id="edit-note-btn" class="tool-button notes-edit-toggle" type="button" title="Edit markdown" aria-label="Edit note" aria-pressed="false"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>
            </div>
          </div>
        </app-action-bar>
      </section>`;
    for (const [id, run] of Object.entries({
      'delete-note-btn': 'delete', 'copy-note-btn': 'copy', 'note-properties-btn': 'properties',
      'note-versions-btn': 'versions', 'edit-note-btn': 'edit',
    })) host.querySelector(`#${id}`)?.addEventListener('click', () => this.actions[run]());

    this.table = host.querySelector('#notes-data-table');
    this.pagination = host.querySelector('#notes-table-pagination');
    this.statsGrid = host.querySelector('#notes-table-stats-grid');
    if (!hasColumns) {
      this.table.setColumns([{ key: 'empty', label: 'Table' }]);
      this.table.setEmptyState({ icon: 'fa-table', title: 'No markdown table found', subtitle: 'Add a markdown table to this note (the pencil edits its text) to work with its rows here.' });
      this.table.setData([]);
      return;
    }
    this.bind();
    this.update();
    this.loadLinks();
  }

  bind() {
    const { host, table, pagination } = this;
    table.setColumns(this.parsed.columns.map((col) => ({
      key: col.key,
      label: col.label,
      sortable: true,
      sortValue: (value) => resolveCellDisplay(value, this.titles).label,
      render: (value) => resolveCellSegments(value, this.titles).map((seg) => {
        if (seg.type !== 'wikilink') return esc(seg.text);
        const slug = this.slugs.get(seg.target);
        return slug
          ? `<a class="notes-wikilink" data-slug="${esc(slug)}" href="/notes/${esc(encodeURIComponent(slug))}">${esc(seg.label)}</a>`
          : `<span class="notes-wikilink unresolved">${esc(seg.label)}</span>`;
      }).join(''),
    })));
    table.addEventListener('sort-change', (event) => {
      this.sort = event.detail;
      this.page = 0;
      this.update();
    });
    table.addEventListener('click', (event) => {
      const link = event.target.closest('a.notes-wikilink');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const url = `/notes/${encodeURIComponent(link.dataset.slug)}`;
      if (event.metaKey || event.ctrlKey || event.button === 1) window.open(url, '_blank');
      else this.actions.go(url);
    });
    host.querySelector('.notes-table-filter').addEventListener('input', (event) => {
      this.query = event.target.value;
      this.page = 0;
      this.update();
    });
    pagination.addEventListener('page-change', (event) => {
      this.page = event.detail.page;
      this.update();
    });
    // "/" jumps to the filter, as the key hint beside it says (not while typing in a field or with a dialog open).
    this.onKey = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('app-dialog:not(.is-hidden)')) return;
      event.preventDefault();
      host.querySelector('.notes-table-filter')?.focus();
    };
    document.addEventListener('keydown', this.onKey);
    this.drawer = this.createDrawer();
    table.addEventListener('row-click', (event) => event.detail?.rowData && this.drawer.open(event.detail.rowData));
    host.querySelector('#add-table-row-btn').addEventListener('click', () => this.drawer.open(null));
  }

  update() {
    const { parsed, table, pagination } = this;
    this.renderStats();
    const filtered = filterTableRows(parsed.rows, parsed.columns, this.query, this.titles);
    const rows = this.sort ? sortTableRows(filtered, this.sort.key, this.sort.dir, this.titles) : filtered;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    const filtering = Boolean(this.query.trim());
    table.setEmptyState({
      icon: 'fa-table',
      title: filtering ? 'No matching rows' : 'No rows yet',
      subtitle: filtering ? 'Try adjusting your filter.' : 'Click "Add row" to add the first row.',
    });
    table.setData(rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE));
    pagination.setAttribute('page', String(this.page));
    pagination.setAttribute('page-size', String(PAGE_SIZE));
    pagination.setAttribute('total-items', String(rows.length));
    pagination.setAttribute('total-pages', String(pages));
    pagination.hidden = rows.length <= PAGE_SIZE;
    const count = this.host.querySelector('#notes-table-row-count');
    if (count) count.textContent = parsed.rows.length.toLocaleString();
  }

  renderStats() {
    const config = parseTableStatsConfig(this.note.content);
    if (!config.length) {
      this.statsGrid.hidden = true;
      this.statsGrid.replaceChildren();
      return;
    }
    const cards = evaluateTableStats(config, this.parsed);
    this.statsGrid.hidden = false;
    this.statsGrid.style.setProperty('--stats-count', String(Math.min(5, Math.max(1, cards.length))));
    this.statsGrid.innerHTML = cards
      .map((card) => renderStatCard({ title: card.label, value: card.value, icon: card.icon, sub: card.sub, color: card.color }))
      .join('');
  }

  // Name the notes the cells link to (and the people the drawer offers); the table redraws when they are known.
  async loadLinks() {
    const slug = this.slug;
    const stale = () => this.slug !== slug || !this.host.isConnected;
    const targets = new Set();
    for (const row of this.parsed.rows) {
      for (const col of this.parsed.columns) for (const target of extractWikilinkTargets(row[col.key])) targets.add(target);
    }
    const missing = [...targets].filter((target) => !this.slugs.has(target));
    try {
      for (let i = 0; i < missing.length; i += RESOLVE_CHUNK) {
        const resolved = await api(`/resolve?${missing.slice(i, i + RESOLVE_CHUNK).map((t) => `target=${encodeURIComponent(t)}`).join('&')}`);
        if (stale()) return;
        for (const [target, hit] of Object.entries(resolved)) {
          if (!hit) continue;
          this.slugs.set(target, hit.slug);
          this.titles.set(target, hit.title);
        }
      }
      if (missing.length) this.update();
    } catch (error) {
      console.error('Failed to resolve table links:', error); // the cells keep their text
    }
    if (this.parsed.columns.some((col) => col.isWikilink) && !this.people.length) {
      try {
        const notes = await api('/notes?limit=1000');
        if (stale()) return;
        this.people = notes
          .filter((n) => (n.types || []).some((type) => String(type).toLowerCase() === 'contact'))
          .map((n) => ({ value: n.title, label: n.title }));
      } catch (error) {
        console.error('Failed to load contacts:', error); // the drawer offers the names already in the table
      }
    }
  }

  createDrawer() {
    const { columns } = this.parsed;
    const fieldsHtml = `<div class="notes-table-drawer-fields">${columns.map((col) => (col.isWikilink
      ? `<label class="field"><span>${esc(col.label)}</span><app-combobox multiple creatable name="${esc(col.key)}" placeholder="Select ${esc(col.label.toLowerCase())}…"></app-combobox></label>`
      : `<label class="field"><span>${esc(col.label)}</span><input type="text" name="${esc(col.key)}" /></label>`)).join('')}</div>`;
    const first = columns[0];
    return createCrudDrawer({
      host: this.host.querySelector('#notes-table-drawer-host'),
      singularLabel: 'Row',
      initialFocus: first.isWikilink ? `[name="${first.key}"] .combobox-input` : `[name="${first.key}"]`,
      fieldsHtml,
      populateForm: (record, form) => {
        for (const col of this.parsed.columns) {
          const control = form.querySelector(`[name="${col.key}"]`);
          if (!control) continue;
          if (!col.isWikilink) {
            control.value = record ? formatCellValueForEdit(record[col.key]) : '';
            continue;
          }
          const chosen = record ? extractWikilinkTargets(record[col.key]) : [];
          const options = new Map(this.people.map((option) => [option.value, option]));
          for (const target of [...chosen, ...this.titles.keys()]) if (!options.has(target)) options.set(target, { value: target, label: this.titles.get(target) || target });
          control.optionsList = [...options.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
          control.values = chosen;
          control.render?.();
        }
      },
      buildPayload: (form) => {
        const row = {};
        for (const col of this.parsed.columns) {
          const control = form.querySelector(`[name="${col.key}"]`);
          row[col.key] = col.isWikilink
            ? (control?.values || []).map((target) => String(target).trim()).filter(Boolean).map((target) => `[[${target}]]`).join('; ')
            : String(control?.value ?? '').trim();
        }
        return row;
      },
      onSave: async (values, existing) => {
        const rows = [...this.parsed.rows];
        if (existing && Number.isInteger(existing._rowIndex)) rows[existing._rowIndex] = values;
        else rows.push(values);
        await this.persist(rows, existing ? 'Row updated' : 'Row added');
      },
      onDelete: async (existing) => {
        if (!existing || !Number.isInteger(existing._rowIndex)) return false;
        await this.persist(this.parsed.rows.filter((_, index) => index !== existing._rowIndex), 'Row deleted');
        return true;
      },
    });
  }

  // Writes the new rows into the note's markdown and saves it: one commit. The page redraws from what the server kept.
  async persist(rows, message) {
    const slug = this.note.slug;
    const content = serializeMarkdownTableNote(this.parsed, rows);
    const saved = await api(`/notes/${encodeURIComponent(slug)}`, { method: 'PUT', body: { content } });
    if (this.slug !== slug) return;
    this.actions.saved(saved);
    this.note = saved;
    this.parsed = parseMarkdownTableNote(saved.content);
    this.update();
    this.loadLinks();
    showToast(`${message} · ${saved.title}`, 'success');
  }
}

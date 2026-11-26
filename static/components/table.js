import { escapeHtml } from '../html.js';

const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,label,summary,[data-row-action]';
const FA_PREFIX_RE = /^(fa-solid|fa-regular|fa-brands|fa-light|fa-thin|fa-duotone|fas|far|fab)\b/;

export class AppTable extends HTMLElement {
  static get observedAttributes() {
    return ['aria-label', 'sort-mode', 'clickable-rows'];
  }

  constructor() {
    super();
    this.data = [];
    this.columns = [];
    this.isLoading = false;
    this.errorMessage = '';
    this.emptyState = null;
    this._sortKey = null;
    this._sortDir = 'desc';
    this._renderedRows = [];
    this._listenersBound = false;
    this._onClick = (event) => this._handleClick(event);
    this._onKeydown = (event) => this._handleKeydown(event);
  }

  connectedCallback() {
    if (!this._listenersBound && typeof this.addEventListener === 'function') {
      this.addEventListener('click', this._onClick);
      this.addEventListener('keydown', this._onKeydown);
      this._listenersBound = true;
    }
    this.render();
  }

  disconnectedCallback() {
    if (this._listenersBound && typeof this.removeEventListener === 'function') {
      this.removeEventListener('click', this._onClick);
      this.removeEventListener('keydown', this._onKeydown);
      this._listenersBound = false;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === 'aria-label') {
      const table = typeof this.querySelector === 'function' ? this.querySelector('table.data-table') : null;
      if (table) {
        if (newValue) table.setAttribute('aria-label', newValue);
        else table.removeAttribute('aria-label');
        return;
      }
    }
    this._renderBody();
  }

  setColumns(columns) {
    this.columns = columns || [];
    this.render();
  }

  setDefaultSort(key, dir = 'desc') {
    this._sortKey = key || null;
    this._sortDir = dir === 'asc' ? 'asc' : 'desc';
    this.render();
  }

  get sort() {
    return { key: this._sortKey, dir: this._sortDir };
  }

  // With sort-mode="server" the table only reports the chosen sort; the owner fetches the rows in that order.
  get serverSort() {
    return this.getAttribute('sort-mode') === 'server';
  }

  get clickableRows() {
    return typeof this.hasAttribute === 'function' ? this.hasAttribute('clickable-rows') : false;
  }

  set clickableRows(value) {
    this.toggleAttribute?.('clickable-rows', Boolean(value));
  }

  _toggleSort(key) {
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      const column = this.columns.find((col) => col.key === key);
      this._sortKey = key;
      this._sortDir = column?.defaultSortDir === 'asc' ? 'asc' : 'desc';
    }
    this.render();
    if (this.serverSort) {
      this.dispatchEvent(
        new CustomEvent('sort-change', {
          bubbles: true,
          composed: true,
          detail: { key: this._sortKey, dir: this._sortDir },
        })
      );
    }
  }

  _getSortedData() {
    if (this.serverSort || !this.data.length || !this._sortKey) return this.data;
    const column = this.columns.find((col) => col.key === this._sortKey && col.sortable);
    if (!column) return this.data;
    const getVal =
      typeof column.sortValue === 'function'
        ? (row) => column.sortValue(row[column.key], row)
        : (row) => row[column.key];
    const isMissing = (val) =>
      val === null || val === undefined || (typeof val === 'number' && Number.isNaN(val));
    return [...this.data].sort((a, b) => {
      const valA = getVal(a);
      const valB = getVal(b);
      const missA = isMissing(valA);
      const missB = isMissing(valB);
      if (missA && missB) return 0;
      if (missA) return 1;
      if (missB) return -1;
      if (typeof valA === 'number' && typeof valB === 'number') {
        return this._sortDir === 'desc' ? valB - valA : valA - valB;
      }
      const strA = String(valA);
      const strB = String(valB);
      return this._sortDir === 'desc' ? strB.localeCompare(strA) : strA.localeCompare(strB);
    });
  }

  setData(data) {
    this.data = data || [];
    this.isLoading = false;
    this.errorMessage = '';
    this.removeAttribute?.('aria-busy');
    this._renderBody();
  }

  setEmptyState(emptyState) {
    this.emptyState = emptyState || null;
    this._renderBody();
  }

  setLoading(isLoading = true) {
    this.isLoading = Boolean(isLoading);
    this.toggleAttribute?.('aria-busy', this.isLoading);
    this._renderBody();
  }

  setError(message) {
    this.errorMessage = message || 'Unable to load data.';
    this.isLoading = false;
    this.removeAttribute?.('aria-busy');
    this._renderBody();
  }

  _iconClass(icon) {
    const raw = String(icon || 'fa-table-list').trim() || 'fa-table-list';
    return FA_PREFIX_RE.test(raw) ? raw : `fa-solid ${raw}`;
  }

  body(rows = this._getSortedData()) {
    const colCount = Math.max(this.columns.length, 1);
    if (this.isLoading) {
      const cells = Array.from({ length: colCount }, () => '<td><span class="table-skeleton"></span></td>').join('');
      return Array.from({ length: 8 }, () => `<tr class="skeleton-row">${cells}</tr>`).join('');
    }
    if (this.errorMessage) {
      return `<tr class="state-row"><td colspan="${colCount}" class="table-state table-state-error">${this.escape(this.errorMessage)}</td></tr>`;
    }
    if (!rows.length) {
      const state = this.emptyState || {};
      return `<tr class="state-row"><td colspan="${colCount}" class="table-state"><i class="${this.escape(this._iconClass(state.icon))}" aria-hidden="true"></i><strong>${this.escape(state.title || 'No data found')}</strong>${state.subtitle ? `<span>${this.escape(state.subtitle)}</span>` : ''}</td></tr>`;
    }
    const allClickable = this.clickableRows;
    return rows
      .map((row, index) => {
        const clickable = Boolean(row?.clickable || allClickable);
        const rowAttrs = clickable ? ' class="click-row" tabindex="0"' : '';
        return `<tr role="row" data-row-index="${index}"${rowAttrs}>${this.columns
          .map((column) => {
            const value = row[column.key];
            const content =
              typeof column.render === 'function' ? column.render(value, row) : this.escape(value ?? '—');
            return `<td role="cell" class="${this.escape(column.className || '')}"${column.width ? ` style="width:${this.escape(column.width)}"` : ''}>${content}</td>`;
          })
          .join('')}</tr>`;
      })
      .join('');
  }

  _renderHeaderCell(column) {
    const widthAttr = column.width ? ` style="width:${this.escape(column.width)}"` : '';
    if (!column.sortable) {
      return `<th scope="col" role="columnheader" class="${this.escape(column.className || '')}"${widthAttr}>${this.escape(column.label || '')}</th>`;
    }
    const isActive = this._sortKey === column.key;
    const classes = [column.className || '', 'sortable', isActive ? 'active' : ''].filter(Boolean).join(' ');
    const ariaSort = isActive ? (this._sortDir === 'desc' ? 'descending' : 'ascending') : 'none';
    const indicator = isActive ? (this._sortDir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th scope="col" role="columnheader" class="${this.escape(classes)}" data-sort="${this.escape(column.key)}" tabindex="0" aria-sort="${ariaSort}"${widthAttr}><span>${this.escape(column.label || '')}</span><span class="sort-indicator" aria-hidden="true">${indicator}</span></th>`;
  }

  _renderBody() {
    if (!this.isConnected) return;
    const tbody = typeof this.querySelector === 'function' ? this.querySelector('tbody') : null;
    if (!tbody) {
      this.render();
      return;
    }
    this._renderedRows = this._getSortedData();
    tbody.innerHTML = this.body(this._renderedRows);
  }

  render() {
    if (!this.isConnected) return;
    this._renderedRows = this._getSortedData();
    const ariaLabel = this.getAttribute('aria-label');
    const ariaLabelAttr = ariaLabel ? ` aria-label="${this.escape(ariaLabel)}"` : '';
    this.innerHTML = `<table class="data-table" role="table"${ariaLabelAttr}><thead role="rowgroup"><tr role="row">${this.columns.map((column) => this._renderHeaderCell(column)).join('')}</tr></thead><tbody role="rowgroup">${this.body(this._renderedRows)}</tbody></table>`;
  }

  _handleClick(event) {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    if (!target) return;
    const th = target.closest('th.sortable[data-sort]');
    if (th && (typeof this.contains !== 'function' || this.contains(th))) {
      this._toggleSort(th.getAttribute('data-sort'));
      return;
    }
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    const row = target.closest('tr[data-row-index]');
    if (!row || (typeof this.contains === 'function' && !this.contains(row))) return;
    this._emitRowClick(row);
  }

  _handleKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    if (!target) return;
    const th = target.closest('th.sortable[data-sort]');
    if (th && (typeof this.contains !== 'function' || this.contains(th))) {
      event.preventDefault();
      const key = th.getAttribute('data-sort');
      this._toggleSort(key);
      const escapedKey = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(key) : key;
      this.querySelector?.(`th.sortable[data-sort="${escapedKey}"]`)?.focus?.();
      return;
    }
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    const row = target.closest('tr.click-row[data-row-index]');
    if (row && (typeof this.contains !== 'function' || this.contains(row))) {
      event.preventDefault();
      this._emitRowClick(row);
    }
  }

  _emitRowClick(row) {
    const rowIndex = Number(row.dataset.rowIndex);
    const rowData = (this._renderedRows || this.data)[rowIndex];
    this.dispatchEvent(
      new CustomEvent('row-click', {
        detail: { rowIndex, rowData },
        bubbles: true,
        composed: true,
      })
    );
  }

  escape(value) {
    return escapeHtml(value);
  }
}

if (!customElements.get('app-table')) {
  customElements.define('app-table', AppTable);
}

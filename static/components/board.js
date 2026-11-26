import { escapeHtml } from '../html.js';

class AppBoard extends HTMLElement {
  constructor() {
    super();
    this.config = null;
    this.items = [];
    this.isLoading = false;
    this.draggedId = '';
    this.expanded = new Set();
  }
  connectedCallback() {
    this.addEventListener('click', this.onClick);
    this.addEventListener('keydown', this.onKeydown);
    this.addEventListener('row-action', this.onRowAction);
    this.addEventListener('dragstart', this.onDragStart);
    this.addEventListener('dragend', this.onDragEnd);
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
    this.render();
  }
  disconnectedCallback() {
    this.removeEventListener('click', this.onClick);
    this.removeEventListener('keydown', this.onKeydown);
    this.removeEventListener('row-action', this.onRowAction);
    this.removeEventListener('dragstart', this.onDragStart);
    this.removeEventListener('dragend', this.onDragEnd);
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('dragleave', this.onDragLeave);
    this.removeEventListener('drop', this.onDrop);
  }
  configure(config) {
    this.config = config;
    this.items = config.items || [];
    this.isLoading = Boolean(config.loading);
    this.toggleAttribute?.('aria-busy', this.isLoading);
    this.render();
  }
  setData(items) {
    this.items = items || [];
    this.isLoading = false;
    this.removeAttribute?.('aria-busy');
    this.render();
  }
  setLoading(isLoading = true) {
    this.isLoading = isLoading;
    this.toggleAttribute?.('aria-busy', isLoading);
    this.render();
  }
  _renderSkeletonCards(variant) {
    return Array.from(
      { length: 3 },
      () =>
        `<article class="board-card board-card--${escapeHtml(variant)} board-card--skeleton" aria-hidden="true"><div class="board-card-heading"><span class="board-skeleton board-skeleton-title"></span></div><div class="board-card-chips"><span class="board-skeleton board-skeleton-chip"></span><span class="board-skeleton board-skeleton-chip board-skeleton-chip--wide"></span></div></article>`
    ).join('');
  }
  itemFor(target) {
    const id = target.closest('[data-item-id]')?.dataset.itemId;
    return this.items.find((item) => String(this.config.itemId?.(item) ?? item.id) === id);
  }
  render() {
    if (!this.isConnected || !this.config) return;
    const { columns, groupKey, renderCard, columnVariant = (value) => value, columnLimits = {} } = this.config;
    this.innerHTML = `<div class="board">${columns
      .map((column) => {
        const variant = columnVariant(column.value);
        if (this.isLoading) {
          return `<section class="board-column" data-column-value="${escapeHtml(column.value)}"><header class="board-column-header"><span class="board-column-title">${escapeHtml(column.label)}</span><span class="board-column-count"><span class="board-skeleton board-skeleton-count" aria-hidden="true"></span></span></header><div class="board-cards">${this._renderSkeletonCards(variant)}</div></section>`;
        }
        const items = this.items.filter((item) => groupKey(item) === column.value);
        const limit = columnLimits[column.value];
        const hidden = limit && !this.expanded.has(column.value) ? Math.max(items.length - limit, 0) : 0;
        const shown = hidden ? items.slice(0, limit) : items;
        const more = hidden
          ? `<button type="button" class="board-show-more" data-show-more="${escapeHtml(column.value)}">Show ${hidden} more</button>`
          : '';
        return `<section class="board-column" data-column-value="${escapeHtml(column.value)}"><header class="board-column-header"><span class="board-column-title">${escapeHtml(column.label)}</span><span class="board-column-count">${items.length}</span></header><div class="board-cards">${shown.length ? shown.map((item) => `<article class="board-card board-card--${escapeHtml(variant)}" data-item-id="${escapeHtml(this.config.itemId?.(item) ?? item.id)}" draggable="true" role="button" tabindex="0">${renderCard(item)}</article>`).join('') + more : '<p class="board-empty">No items</p>'}</div></section>`;
      })
      .join('')}</div>`;
  }
  onClick = (event) => {
    const showMore = event.target.closest('[data-show-more]');
    if (showMore) {
      this.expanded.add(showMore.dataset.showMore);
      this.render();
      return;
    }
    if (event.target.closest('button,a,input,select,textarea,[data-row-action]')) return;
    const item = this.itemFor(event.target);
    if (item) this.config.onCardClick?.(item);
  };
  onKeydown = (event) => {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('button,a,input,select,textarea,[data-row-action]'))
      return;
    const item = this.itemFor(event.target);
    if (item) {
      event.preventDefault();
      this.config.onCardClick?.(item);
    }
  };
  onRowAction = (event) => {
    const item = this.items.find((entry) => Number(this.config.itemId?.(entry) ?? entry.id) === event.detail.id);
    if (!item) return;
    if (event.detail.action === 'edit') this.config.onEdit?.(item);
    if (event.detail.action === 'delete') this.config.onDelete?.(item);
  };
  onDragStart = (event) => {
    const card = event.target.closest('.board-card');
    if (!card) return;
    this.draggedId = card.dataset.itemId;
    event.dataTransfer.setData('text/plain', this.draggedId);
    event.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => card.classList.add('board-card--dragging'));
  };
  onDragEnd = () => {
    this.draggedId = '';
    this.querySelectorAll('.board-card--dragging,.board-column--drag-over').forEach((element) =>
      element.classList.remove('board-card--dragging', 'board-column--drag-over')
    );
  };
  onDragOver = (event) => {
    if (!this.draggedId) return;
    const column = event.target.closest('.board-column');
    if (column) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('board-column--drag-over');
    }
  };
  onDragLeave = (event) => {
    const column = event.target.closest('.board-column');
    if (column && !column.contains(event.relatedTarget)) column.classList.remove('board-column--drag-over');
  };
  onDrop = async (event) => {
    const column = event.target.closest('.board-column');
    if (!column) return;
    event.preventDefault();
    column.classList.remove('board-column--drag-over');
    const item = this.items.find(
      (entry) =>
        String(this.config.itemId?.(entry) ?? entry.id) === (event.dataTransfer.getData('text/plain') || this.draggedId)
    );
    const next = column.dataset.columnValue;
    if (!item || !next || this.config.groupKey(item) === next) return;
    column.setAttribute('aria-busy', 'true');
    try {
      await this.config.onDrop?.(item, next, this.config.groupKey(item));
    } catch (error) {
      this.dispatchEvent(new CustomEvent('board-error', { detail: { error }, bubbles: true }));
    } finally {
      column.removeAttribute('aria-busy');
    }
  };
}
customElements.define('app-board', AppBoard);

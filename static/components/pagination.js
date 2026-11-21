class AppPagination extends HTMLElement {
  static get observedAttributes() {
    return ['page', 'total-pages', 'total-items', 'page-size'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(_name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  get page() {
    return parseInt(this.getAttribute('page')) || 0;
  }
  get totalPages() {
    return parseInt(this.getAttribute('total-pages')) || 1;
  }
  get totalItems() {
    return parseInt(this.getAttribute('total-items')) || 0;
  }
  get pageSize() {
    return parseInt(this.getAttribute('page-size')) || 10;
  }

  get startItem() {
    return this.totalItems === 0 ? 0 : this.page * this.pageSize + 1;
  }

  get endItem() {
    return Math.min((this.page + 1) * this.pageSize, this.totalItems);
  }

  formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  goToPage(page) {
    if (page >= 0 && page < this.totalPages) {
      this.dispatchEvent(
        new CustomEvent('page-change', {
          bubbles: true,
          composed: true,
          detail: { page },
        })
      );
    }
  }

  getVisiblePages() {
    const total = this.totalPages;
    const current = this.page;

    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i);
    }

    // Two-page boundary at each end, plus current's immediate
    // siblings, deduped and clamped to valid page indices.
    const candidates = new Set([0, 1, total - 2, total - 1, current - 1, current, current + 1]);
    const sorted = [...candidates].filter((p) => p >= 0 && p < total).sort((a, b) => a - b);

    const pages = [];
    let prev = null;
    for (const p of sorted) {
      if (prev !== null && p - prev > 1) pages.push('...');
      pages.push(p);
      prev = p;
    }
    return pages;
  }

  render() {
    const visiblePages = this.getVisiblePages();

    this.shadowRoot.innerHTML = `
            <link rel="stylesheet" href="/static/vendor/fontawesome/css/all.min.css?v=1">
            <style>
                :host {
                    display: block;
                }

                .pagination {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0.75rem 0;
                    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
                }

                .info {
                    font-size: 0.875rem;
                    color: var(--color-dimmed2);
                }

                .info strong {
                    color: var(--color-text);
                    font-weight: 500;
                }

                /* Same segmented look as the header tab bar (components/tab-bar.css): a bordered dark track,
                   dim labels, and the blue tint with blue text for the selected page. */
                .nav {
                    display: inline-flex;
                    align-items: center;
                    box-sizing: border-box;
                    gap: 2px;
                    padding: 3px;
                    border: var(--header-control-border);
                    border-radius: var(--radius-md);
                    background: var(--header-control-bg);
                }

                .nav-btn, .page-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    height: 2rem;
                    min-width: 2rem;
                    padding: 0 0.5rem;
                    border: 0;
                    border-radius: 6px;
                    background: transparent;
                    color: var(--color-dimmed2);
                    font: inherit;
                    font-size: 0.78rem;
                    font-weight: 700;
                    cursor: pointer;
                    transition: background 0.15s ease, color 0.15s ease;
                }

                .nav-btn:hover:not(:disabled), .page-btn:hover:not(.active):not(.ellipsis) {
                    color: var(--color-text);
                }

                .nav-btn:focus-visible, .page-btn:focus-visible {
                    outline: var(--focus-ring);
                    outline-offset: var(--focus-offset-tight);
                }

                .nav-btn:disabled {
                    color: var(--color-dimmed3);
                    cursor: not-allowed;
                }

                .page-btn.active, .page-btn.active:hover {
                    background: var(--color-state-selected-bg);
                    color: var(--color-state-selected-text);
                }

                .page-btn.ellipsis {
                    color: var(--color-dimmed3);
                    cursor: default;
                }

                .page-numbers {
                    display: contents;
                }
            </style>

            <div class="pagination">
                <div class="info">
                    Showing <strong>${this.formatNumber(this.startItem)}</strong> to <strong>${this.formatNumber(this.endItem)}</strong> of <strong>${this.formatNumber(this.totalItems)}</strong>
                </div>
                <nav class="nav" aria-label="Pagination">
                    <button class="nav-btn" data-action="prev" ${this.page === 0 ? 'disabled' : ''} aria-label="Previous">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <span class="page-numbers">
                        ${visiblePages
                          .map((p) => {
                            if (p === '...') {
                              return `<span class="page-btn ellipsis">...</span>`;
                            }
                            return `<button class="page-btn ${p === this.page ? 'active' : ''}" data-page="${p}">${p + 1}</button>`;
                          })
                          .join('')}
                    </span>
                    <button class="nav-btn" data-action="next" ${this.page >= this.totalPages - 1 ? 'disabled' : ''} aria-label="Next">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </nav>
            </div>
        `;

    // Event listeners
    this.shadowRoot.querySelectorAll('.page-btn:not(.ellipsis)').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.goToPage(parseInt(btn.dataset.page));
      });
    });

    this.shadowRoot.querySelector('[data-action="prev"]')?.addEventListener('click', () => {
      this.goToPage(this.page - 1);
    });

    this.shadowRoot.querySelector('[data-action="next"]')?.addEventListener('click', () => {
      this.goToPage(this.page + 1);
    });
  }
}

customElements.define('app-pagination', AppPagination);

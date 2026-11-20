const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.userAgent || navigator.platform || '');
const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K';

let lastFocusedAutocomplete = null;

function isTypingContext(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  return path.some((target) => {
    if (!(target instanceof Element)) return false;
    return (
      target.matches('input, textarea, select, [contenteditable="true"]') ||
      Boolean(target.closest?.('input, textarea, select, [contenteditable="true"], .cm-content, .cm-editor'))
    );
  });
}

function findCandidateAutocompletes(root = document) {
  const list = [];
  const walk = (node) => {
    if (!node) return;
    if (node.querySelectorAll) {
      list.push(...node.querySelectorAll('app-autocomplete'));
    }
    const children = node.querySelectorAll ? node.querySelectorAll('*') : [];
    for (const child of children) {
      if (child.shadowRoot) walk(child.shadowRoot);
    }
  };
  walk(root);
  return list.filter((el) => el.isConnected && el.getClientRects().length > 0 && !el.closest('[hidden]'));
}

function getActiveSearchAutocomplete() {
  if (lastFocusedAutocomplete?.isConnected && lastFocusedAutocomplete.getClientRects().length > 0) {
    return lastFocusedAutocomplete;
  }
  const candidates = findCandidateAutocompletes();
  if (!candidates.length) return null;

  // Prioritize header search bars
  const headerMatch = candidates.find((el) => {
    const isHeaderChild = Boolean(el.closest('app-header, header, .page-header-content, .header-actions'));
    const isHeaderId = /search/i.test(el.id || el.getAttribute('input-id') || '');
    return isHeaderChild || isHeaderId;
  });

  return headerMatch || candidates[0];
}

document.addEventListener(
  'keydown',
  (event) => {
    const isSlash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (!isSlash || isTypingContext(event)) return;

    const autocomplete = getActiveSearchAutocomplete();
    if (!autocomplete?.input) return;

    event.preventDefault();
    autocomplete.input.focus();
    autocomplete.input.select();
  },
  true
);

class AppAutocomplete extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'placeholder', 'title'];
  }

  connectedCallback() {
    if (this._rendered) {
      if (!this._onDocClick) {
        this._onDocClick = (event) => {
          if (!this.contains(event.target)) {
            this.clearResults();
            this.closeHelp();
          }
        };
        document.addEventListener('click', this._onDocClick);
      }
      return;
    }
    this._rendered = true;

    const inputId = this.getAttribute('input-id') || `${this.id || 'autocomplete'}-input`;
    const initialValue = this.getAttribute('value') || '';
    const initialTitle = this.getAttribute('title') || '';
    const showShortcut = !this.hasAttribute('no-shortcut');

    // Dedicated help slot or help content
    const helpNode = this.querySelector('[slot="help"], .autocomplete-help');
    if (helpNode) helpNode.remove();

    // Preserve any generic suffix children
    const suffixNodes = [
      ...this.querySelectorAll('[slot="suffix"], .autocomplete-suffix'),
    ];
    suffixNodes.forEach((node) => node.remove());

    const hasHelp = Boolean(helpNode);
    const hasSuffix = suffixNodes.length > 0;
    const hasShortcut = showShortcut && !hasHelp;

    let controlClasses = 'autocomplete-control';
    if (hasSuffix) controlClasses += ' has-suffix';
    if (hasHelp) controlClasses += ' has-help';
    if (hasShortcut) controlClasses += ' has-shortcut';

    const badgeText = this.getAttribute('shortcut') || '/';
    const badgeTitle = 'Search (/)';

    this.innerHTML = `<div class="${controlClasses}"><i class="fa-solid fa-magnifying-glass autocomplete-icon" aria-hidden="true"></i><input id="${esc(inputId)}" class="autocomplete-input" type="search" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="${esc(inputId)}-results" placeholder="${esc(this.getAttribute('placeholder') || '')}" value="${esc(initialValue)}"${initialTitle ? ` title="${esc(initialTitle)}"` : ''} /><button type="button" class="autocomplete-clear-btn" aria-label="Clear search" tabindex="-1"${initialValue ? '' : ' hidden'}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>${hasShortcut ? `<kbd class="autocomplete-shortcut-badge" title="${esc(badgeTitle)}" aria-hidden="true">${esc(badgeText)}</kbd>` : ''}${hasSuffix ? `<div class="autocomplete-suffix-container"></div>` : ''}${hasHelp ? `<button type="button" class="autocomplete-help-btn" aria-label="Search syntax help" title="Search syntax help" aria-expanded="false" aria-controls="${esc(inputId)}-help"><i class="fa-solid fa-circle-info" aria-hidden="true"></i></button><div class="autocomplete-help-panel" id="${esc(inputId)}-help" role="region" aria-label="Search help details" hidden></div>` : ''}<div class="autocomplete-results" id="${esc(inputId)}-results" role="listbox" hidden></div></div>`;

    if (hasSuffix) {
      const suffixContainer = this.querySelector('.autocomplete-suffix-container');
      if (suffixContainer) {
        suffixNodes.forEach((node) => suffixContainer.appendChild(node));
      }
    }

    if (hasHelp) {
      this.helpBtn = this.querySelector('.autocomplete-help-btn');
      this.helpPanel = this.querySelector('.autocomplete-help-panel');
      if (this.helpPanel && helpNode) {
        this.helpPanel.appendChild(helpNode);
      }
    } else {
      this.helpBtn = null;
      this.helpPanel = null;
    }

    this.input = this.querySelector('.autocomplete-input');
    this.clearBtn = this.querySelector('.autocomplete-clear-btn');
    this.shortcutBadge = this.querySelector('.autocomplete-shortcut-badge');
    this.results = this.querySelector('.autocomplete-results');
    this.activeIndex = -1;

    if (this._options) {
      this.options = this._options;
    }

    this.helpBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      this.toggleHelp();
    });

    this.input.addEventListener('focus', () => {
      lastFocusedAutocomplete = this;
      this.updateClearBtn();
    });
    this.input.addEventListener('blur', () => {
      this.updateClearBtn();
    });
    this.input.addEventListener('input', () => {
      if (this.isHelpOpen()) {
        this.closeHelp();
      }
      this.updateClearBtn();
      this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    this.input.addEventListener('search', () => {
      this.updateClearBtn();
      this.dispatchEvent(new Event('search', { bubbles: true, composed: true }));
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.isHelpOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.closeHelp();
          this.input?.focus();
          return;
        }
        if (this.results && !this.results.hidden) {
          this.clearResults();
        } else if (this.input?.value) {
          this.clearInput();
        } else {
          this.input?.blur();
        }
        return;
      }
      if (!this._options?.length || this.results?.hidden) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex = (this.activeIndex + direction + this._options.length) % this._options.length;
        this.updateActiveOption();
      } else if ((event.key === 'Enter' || event.key === 'Tab') && this.activeIndex >= 0) {
        event.preventDefault();
        this.choose(this._options[this.activeIndex]);
      }
    });

    this.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isHelpOpen()) {
        event.preventDefault();
        event.stopPropagation();
        this.closeHelp();
        this.input?.focus();
      }
    });

    this.clearBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.clearInput();
    });

    this._onDocClick = (event) => {
      if (!this.contains(event.target)) {
        this.clearResults();
        this.closeHelp();
      }
    };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    if (this._onDocClick) {
      document.removeEventListener('click', this._onDocClick);
      this._onDocClick = null;
    }
    this.closeHelp();
  }

  isHelpOpen() {
    return Boolean(this.helpPanel && !this.helpPanel.hidden);
  }

  openHelp() {
    if (!this.helpPanel || !this.helpBtn) return;
    this.clearResults();
    this.helpPanel.hidden = false;
    this.helpBtn.setAttribute('aria-expanded', 'true');
    this.classList.add('help-open');
  }

  closeHelp() {
    if (!this.helpPanel || !this.helpBtn) return;
    this.helpPanel.hidden = true;
    this.helpBtn.setAttribute('aria-expanded', 'false');
    this.classList.remove('help-open');
  }

  toggleHelp() {
    if (this.isHelpOpen()) {
      this.closeHelp();
    } else {
      this.openHelp();
    }
  }

  focus() {
    this.input?.focus();
  }

  select() {
    this.input?.select();
  }

  updateClearBtn() {
    if (this.clearBtn && this.input) {
      this.clearBtn.hidden = !this.input.value;
    }
    if (this.shortcutBadge && this.input) {
      const isFocused = document.activeElement === this.input;
      this.shortcutBadge.hidden = Boolean(this.input.value) || isFocused;
    }
  }

  clearInput() {
    if (!this.input) return;
    this.closeHelp();
    this.input.value = '';
    this.setAttribute('value', '');
    this.updateClearBtn();
    this.clearResults();
    this.input.focus();
    this.input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.input.dispatchEvent(new Event('search', { bubbles: true, composed: true }));
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.input) return;
    if (name === 'value') {
      this.input.value = newValue || '';
      this.updateClearBtn();
    } else if (name === 'placeholder') {
      this.input.placeholder = newValue || '';
    } else if (name === 'title') {
      if (newValue) {
        this.input.title = newValue;
      } else {
        this.input.removeAttribute('title');
      }
    }
  }

  set options(items) {
    this._options = items || [];
    this.activeIndex = -1;
    if (!this.results || !this.input) return;
    this.results.innerHTML = this._options
      .map(
        (item, index) => {
          const iconClass = item.iconClass || item.badgeClass || '';
          const iconHtml = item.icon ? `<i class="${esc(item.icon)} autocomplete-option-icon${iconClass ? ` ${esc(iconClass)}` : ''}" aria-hidden="true"></i>` : '';
          const badgeHtml = item.badge ? `<span class="autocomplete-badge ${esc(item.badgeClass || '')}">${esc(item.badge)}</span>` : '';
          return `<button type="button" class="autocomplete-option" id="${esc(this.input.id)}-option-${index}" data-value="${esc(item.value)}" role="option" aria-selected="false"><span class="autocomplete-option-content">${iconHtml}<span class="autocomplete-option-label">${esc(item.label)}</span></span>${badgeHtml}</button>`;
        }
      )
      .join('');
    this.results.hidden = this._options.length === 0;
    this.input.setAttribute('aria-expanded', String(!this.results.hidden));
    this.results.querySelectorAll('[data-value]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = this._options.find((option) => String(option.value) === button.dataset.value);
        this.choose(item || { value: button.dataset.value, label: button.textContent });
      });
    });
  }
  get value() {
    return this.input ? this.input.value : this.getAttribute('value') || '';
  }
  set value(value) {
    const v = value || '';
    if (this.input) this.input.value = v;
    this.updateClearBtn();
    this.setAttribute('value', v);
  }
  updateActiveOption() {
    const options = [...this.results.querySelectorAll('.autocomplete-option')];
    options.forEach((option, index) => {
      const active = index === this.activeIndex;
      option.classList.toggle('active', active);
      option.setAttribute('aria-selected', String(active));
    });
    const activeOption = options[this.activeIndex];
    if (activeOption) {
      activeOption.scrollIntoView({ block: 'nearest' });
      this.input.setAttribute('aria-activedescendant', activeOption.id || '');
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }
  choose(item) {
    if (!item) return;
    this.closeHelp();
    const selectEvent = new CustomEvent('select', {
      detail: { value: String(item.value), label: item.label, item },
      bubbles: true,
      cancelable: true,
    });
    const defaultPrevented = !this.dispatchEvent(selectEvent);
    if (!defaultPrevented) {
      this.input.value = item.label;
    }
    this.updateClearBtn();
    this.clearResults();
  }
  clearResults() {
    if (this.results) this.results.hidden = true;
    this.activeIndex = -1;
    this.input?.removeAttribute('aria-activedescendant');
    this.input?.setAttribute('aria-expanded', 'false');
  }
}
customElements.define('app-autocomplete', AppAutocomplete);

// Shared searchable combobox component used by service views.
let comboId = 0;
const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

class AppCombobox extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'disabled', 'multiple', 'creatable'];
  }
  constructor() {
    super();
    this._id = `app-combobox-${++comboId}`;
    this._optionsList = [];
    this.selectedValue = '';
    this.selectedValues = new Set();
    this.searchQuery = '';
    this.active = -1;
    this.opened = false;
    this._initialized = false;
    this._outside = (event) => {
      const path = event.composedPath();
      if (!path.includes(this) && !path.includes(this.popup)) this.close();
    };
  }
  get isMultiple() {
    return Boolean(this.hasAttribute?.('multiple'));
  }
  get optionsList() {
    return this._optionsList || [];
  }
  set optionsList(list) {
    const seen = new Set();
    this._optionsList = (list || []).filter((opt) => {
      const key = String(opt?.value ?? opt?.label ?? '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  async connectedCallback() {
    // A defined custom element can connect while its declarative <option>
    // children are still being attached by an innerHTML parse.
    await Promise.resolve();
    if (!this.isConnected) return;
    const declarative = Array.from(this.querySelectorAll(':scope > option'));
    if (!this.optionsList.length && declarative.length) {
      this.optionsList = declarative.map((option) => ({
        value: option.value,
        label: option.textContent.trim(),
        icon: option.dataset.icon || '',
      }));
    }
    const attrVal = this.getAttribute('value');
    if (this.isMultiple) {
      if (attrVal !== null) {
        const items = (attrVal || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        this.selectedValues = new Set(items);
      } else if (declarative.length) {
        const selected = declarative.filter((opt) => opt.hasAttribute('selected')).map((opt) => opt.value);
        this.selectedValues = new Set(selected);
      }
    } else {
      if (attrVal !== null) {
        this.selectedValue = attrVal || '';
      } else if (declarative.length) {
        const selected = declarative.find((opt) => opt.hasAttribute('selected'));
        this.selectedValue = selected ? selected.value : '';
      }
    }
    this._initialized = true;
    this.render();
    document.addEventListener('pointerdown', this._outside);
  }
  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._outside);
  }
  attributeChangedCallback(name, _old, value) {
    if (name === 'value') {
      if (this.isMultiple) {
        const items = (value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        this.selectedValues = new Set(items);
      } else {
        this.selectedValue = value || '';
      }
      this.searchQuery = '';
    }
    if (name === 'multiple') {
      if (this.isMultiple && this.selectedValue) {
        this.selectedValues = new Set([this.selectedValue]);
      } else if (!this.isMultiple && this.selectedValues.size) {
        this.selectedValue = Array.from(this.selectedValues)[0] || '';
      }
    }
    if (this._initialized && this.isConnected) this.render();
  }
  get value() {
    if (this.isMultiple) {
      return Array.from(this.selectedValues).join(',');
    }
    return this.selectedValue;
  }
  set value(value) {
    this.setAttribute?.('value', String(value ?? ''));
  }
  get values() {
    if (this.isMultiple) {
      return Array.from(this.selectedValues);
    }
    return this.selectedValue ? [this.selectedValue] : [];
  }
  set values(list) {
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    if (this.isMultiple) {
      this.selectedValues = new Set(arr.map((v) => String(v ?? '')));
      this.setAttribute('value', Array.from(this.selectedValues).join(','));
    } else {
      this.value = arr[0] || '';
    }
  }
  get selected() {
    return this.optionsList.find((option) => String(option.value) === this.value);
  }
  // `creatable` (with `multiple`): what is typed can be added as a value of its own, e.g. a new tag.
  get isCreatable() {
    return this.isMultiple && this.hasAttribute('creatable');
  }
  /** The option a typed text stands for: an existing one that matches it (exactly, else ignoring case), else a new value. */
  resolveTyped(text) {
    const typed = String(text ?? '').replace(/,/g, ' ').trim().replace(/\s+/g, ' ');
    if (!typed) return null;
    const same = (a, b) => String(a) === typed ? 1 : String(a).toLowerCase() === typed.toLowerCase() ? 2 : 0;
    const known = [...this.optionsList, ...Array.from(this.selectedValues, (value) => ({ value, label: value }))];
    const found = known.filter((o) => same(o.value, typed)).sort((a, b) => same(a.value, typed) - same(b.value, typed))[0];
    return found ? { value: String(found.value), label: found.label } : { value: typed, label: typed, create: true };
  }
  get filtered() {
    const query = this.searchQuery.trim().toLowerCase();
    const matches = query ? this.optionsList.filter((option) => option.label.toLowerCase().includes(query)) : this.optionsList;
    if (!this.isCreatable || !query) return matches;
    const typed = this.resolveTyped(this.searchQuery);
    return !typed || !typed.create ? matches : [...matches, { value: typed.value, label: `Create "${typed.label}"`, icon: 'fa-solid fa-plus', create: true }];
  }
  /** Add the text typed so far (Enter, comma or leaving the field) as a value. */
  commitTyped() {
    const typed = this.resolveTyped(this.searchQuery);
    this.searchQuery = '';
    if (!typed || this.selectedValues.has(typed.value)) {
      if (this.input) this.input.value = '';
      return;
    }
    this.selectedValues.add(typed.value);
    this.setAttribute('value', Array.from(this.selectedValues).join(','));
    this.render();
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  render() {
    this.opened = false; // drawing replaces the popup too, so it is closed; open() shows the new one
    const ariaLabel = this.getAttribute('aria-label');
    const name = this.getAttribute('name');
    const disabled = this.hasAttribute('disabled');
    const required = this.hasAttribute('required');
    const hasSelection = this.isMultiple ? this.selectedValues.size > 0 : this.value !== '';
    const clearable = !required && !disabled && hasSelection;

    if (this.isMultiple) {
      const hiddenInputs = name
        ? Array.from(this.selectedValues)
            .map((val) => `<input type="hidden" name="${esc(name)}" value="${esc(val)}">`)
            .join('')
        : '';
      const chips = Array.from(this.selectedValues)
        .map((val) => {
          const opt = this.optionsList.find((o) => String(o.value) === String(val));
          const chipLabel = opt?.label || val;
          return `<span class="combobox-chip" data-value="${esc(val)}"><span class="combobox-chip-label" title="${esc(chipLabel)}">${esc(chipLabel)}</span><button type="button" class="combobox-chip-remove" aria-label="Remove ${esc(chipLabel)}" data-value="${esc(val)}"${disabled ? ' disabled' : ''}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
        })
        .join('');
      const placeholder = this.selectedValues.size ? '' : esc(this.getAttribute('placeholder') || 'Select options');
      this.innerHTML = `<div class="combobox-control${clearable ? ' combobox-control--clearable' : ''} combobox-control--multiple">${hiddenInputs}<div class="combobox-chips">${chips}<input class="combobox-input" type="text" value="${esc(this.searchQuery)}" placeholder="${placeholder}" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="${this._id}"${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}${required && !this.selectedValues.size ? ' required' : ''}></div>${clearable ? '<button type="button" class="combobox-clear" aria-label="Clear selection"><i class="fa-solid fa-xmark"></i></button>' : ''}<button type="button" class="combobox-toggle" aria-label="Show options"><i class="fa-solid fa-chevron-down"></i></button></div><div class="combobox-popup" id="${this._id}" popover="manual" role="listbox" aria-multiselectable="true"></div>`;
    } else {
      const label = this.selected?.label || '';
      const hiddenInput = name ? `<input type="hidden" name="${esc(name)}" value="${esc(this.value)}">` : '';
      this.innerHTML = `<div class="combobox-control${clearable ? ' combobox-control--clearable' : ''}">${hiddenInput}<input class="combobox-input" type="text" value="${esc(label)}"${label ? ` title="${esc(label)}"` : ''} placeholder="${esc(this.getAttribute('placeholder') || 'Select option')}" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="${this._id}"${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''} ${required ? 'required' : ''}>${clearable ? '<button type="button" class="combobox-clear" aria-label="Clear selection"><i class="fa-solid fa-xmark"></i></button>' : ''}<button type="button" class="combobox-toggle" aria-label="Show options"><i class="fa-solid fa-chevron-down"></i></button></div><div class="combobox-popup" id="${this._id}" popover="manual" role="listbox"></div>`;
    }

    this.control = this.querySelector('.combobox-control');
    this.input = this.querySelector('.combobox-input');
    this.popup = this.querySelector('.combobox-popup');
    this.input.disabled = disabled;
    this.querySelector('.combobox-toggle').disabled = disabled;

    if (this.isMultiple) {
      this.querySelectorAll('.combobox-chip-remove').forEach((btn) => {
        btn.onclick = (event) => {
          event.stopPropagation();
          this.removeValue(btn.dataset.value);
        };
      });
      this.control.onclick = (event) => {
        if (!event.target.closest('.combobox-chip-remove') && !event.target.closest('.combobox-clear') && !event.target.closest('.combobox-toggle')) {
          this.input.focus();
          this.open(true);
        }
      };
    }

    this.input.onfocus = () => this.input.setAttribute('aria-expanded', String(this.opened));
    this.input.onclick = (event) => {
      event.stopPropagation();
      this.open(true);
    };
    this.input.oninput = () => {
      this.searchQuery = this.input.value;
      if (!this.isMultiple) {
        this.selectedValue = '';
        if (this.input) this.input.title = this.input.value;
        const hidden = this.querySelector('input[type="hidden"]');
        if (hidden) hidden.value = '';
        if (this.hasAttribute('required')) this.input.setCustomValidity('Select an option.');
      }
      if (this.isCreatable) this.active = -1; // Enter then adds what was typed unless an option was arrowed to
      this.open();
      this.drawOptions();
    };
    // `focusout` has no `on…` property, so it needs a listener (an `onfocusout` assignment never fires)
    this.input.addEventListener('focusout', (event) => {
      if (this.isCreatable && this.searchQuery.trim() && !this.contains(event.relatedTarget)) this.commitTyped();
    });
    this.input.onkeydown = (event) => this.keydown(event);
    this.input.onchange = (event) => event.stopPropagation();
    this.querySelector('.combobox-clear')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.isMultiple) {
        this.selectedValues.clear();
        this.setAttribute('value', '');
        if (this.hasAttribute('required')) this.input?.setCustomValidity('Select an option.');
        this.render();
        if (this.opened) {
          this.drawOptions();
          this.positionPopup();
        }
        this.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        this.choose(null);
      }
    });
    this.querySelector('.combobox-toggle').onclick = (event) => {
      event.stopPropagation();
      this.opened ? this.close() : this.open(true);
    };
  }
  removeValue(val) {
    if (this.hasAttribute('disabled')) return;
    this.selectedValues.delete(String(val));
    this.setAttribute('value', Array.from(this.selectedValues).join(','));
    if (this.hasAttribute('required')) {
      if (!this.selectedValues.size) this.input?.setCustomValidity('Select an option.');
      else this.input?.setCustomValidity('');
    }
    this.render();
    if (this.opened) {
      this.drawOptions();
      this.positionPopup();
    }
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  open(showAll = false) {
    if (this.hasAttribute('disabled')) return;
    if (showAll) this.searchQuery = '';
    if (this.opened) {
      if (showAll) {
        this.active = this.filtered.findIndex((option) =>
          this.isMultiple ? this.selectedValues.has(String(option.value)) : String(option.value) === String(this.value)
        );
        this.drawOptions();
      }
      return;
    }
    this.opened = true;
    this.active = this.filtered.findIndex((option) =>
      this.isMultiple ? this.selectedValues.has(String(option.value)) : String(option.value) === String(this.value)
    );
    this.drawOptions();
    this.popup.showPopover();
    this.positionPopup();
    this.input.setAttribute('aria-expanded', 'true');
  }
  positionPopup() {
    const target = this.control || this.input;
    const rect = target.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 220), innerWidth - edge * 2);
    this.popup.style.width = `${width}px`;
    this.popup.style.left = `${Math.max(edge, Math.min(rect.left, innerWidth - width - edge))}px`;

    const height = this.popup.getBoundingClientRect().height;
    const spaceBelow = innerHeight - rect.bottom - edge - gap;
    const spaceAbove = rect.top - edge - gap;
    const showAbove = spaceBelow < height && spaceAbove > spaceBelow;
    const anchoredTop = showAbove ? rect.top - height - gap : rect.bottom + gap;
    this.popup.style.top = `${Math.max(edge, Math.min(anchoredTop, innerHeight - height - edge))}px`;
  }
  close() {
    if (!this.opened) return;
    this.popup?.hidePopover();
    this.opened = false;
    this.input?.setAttribute('aria-expanded', 'false');
  }
  drawOptions() {
    const seen = new Set();
    const options = this.filtered.filter((option) => {
      const key = String(option?.value ?? option?.label ?? '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // An option with a `group` gets a heading above it where the group changes.
    let group = '';
    this.popup.innerHTML = options.length
      ? options
          .map((option, index) => {
            const heading = option.group && option.group !== group ? `<div class="combobox-group" role="presentation">${esc(option.group)}</div>` : '';
            group = option.group || group;
            const selected = this.isMultiple
              ? this.selectedValues.has(String(option.value))
              : String(option.value) === String(this.value);
            const icon = option.icon ? `<i class="combobox-option-icon ${esc(option.icon)}" aria-hidden="true"></i>` : '';
            return `${heading}<button type="button" class="combobox-option${selected ? ' selected' : ''}${index === this.active ? ' active' : ''}" data-index="${index}" role="option" aria-selected="${selected}" title="${esc(option.label)}">${icon}<span class="combobox-option-label">${esc(option.label)}</span>${option.meta !== undefined ? `<span class="combobox-option-meta">${esc(option.meta)}</span>` : ''}${selected ? '<i class="fa-solid fa-check combobox-option-check" aria-hidden="true"></i>' : ''}</button>`;
          })
          .join('')
      : '<div class="combobox-empty">No options found</div>';
    this.popup.querySelectorAll('[data-index]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        const opt = options[Number(button.dataset.index)];
        if (this.isMultiple) {
          this.toggleOption(opt);
        } else {
          this.choose(opt);
        }
      };
      button.onpointerenter = () => {
        this.active = Number(button.dataset.index);
        this.popup.querySelector('.combobox-option.active')?.classList.remove('active');
        button.classList.add('active');
      };
    });
    if (this.popup.matches(':popover-open')) this.positionPopup();
  }
  choose(option) {
    this.close();
    this.searchQuery = '';
    this.selectedValue = option?.value || '';
    this.setAttribute('value', this.selectedValue);
    this.input?.setCustomValidity('');
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  toggleOption(option) {
    if (!option || this.hasAttribute('disabled')) return;
    const key = String(option.value);
    if (this.selectedValues.has(key)) {
      this.selectedValues.delete(key);
    } else {
      this.selectedValues.add(key);
    }
    this.searchQuery = '';
    this.setAttribute('value', Array.from(this.selectedValues).join(','));
    if (this.hasAttribute('required')) {
      if (!this.selectedValues.size) this.input?.setCustomValidity('Select an option.');
      else this.input?.setCustomValidity('');
    }
    this.render();
    this.open();
    this.input?.focus();
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  keydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (this.isCreatable && (event.key === ',' || (event.key === 'Enter' && this.searchQuery.trim() && this.active < 0))) {
      event.preventDefault();
      this.commitTyped();
      this.input?.focus();
      return;
    }
    if (event.key === 'Backspace' && this.isMultiple && this.searchQuery === '' && this.selectedValues.size) {
      const arr = Array.from(this.selectedValues);
      const last = arr[arr.length - 1];
      this.removeValue(last);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = this.opened;
      this.open();
      const count = this.filtered.length;
      if (count) {
        if (event.key === 'Home') this.active = 0;
        else if (event.key === 'End') this.active = count - 1;
        else if (this.active < 0) this.active = event.key === 'ArrowDown' ? 0 : count - 1;
        else if (wasOpen) this.active = (this.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        this.drawOptions();
        this.popup.querySelector('.combobox-option.active')?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event.key === 'Enter' && this.opened) {
      event.preventDefault();
      const option = this.filtered[this.active];
      if (option) {
        if (this.isMultiple) {
          this.toggleOption(option);
        } else {
          this.choose(option);
        }
      }
    }
  }
}
customElements.define('app-combobox', AppCombobox);

// Shared date-picker component used by service views.
let pickerId = 0;

const iso = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parse = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
};

class AppDatepicker extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'name', 'required'];
  }
  constructor() {
    super();
    this._id = `work-datepicker-${++pickerId}`;
    this._open = false;
    this._outside = (e) => {
      if (!this.contains(e.target)) this.close();
    };
  }
  connectedCallback() {
    this.selected = parse(this.getAttribute('value'));
    this.month = new Date(this.selected || new Date());
    this.render();
    document.addEventListener('pointerdown', this._outside);
  }
  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._outside);
  }
  attributeChangedCallback() {
    if (this.isConnected) {
      this.selected = parse(this.getAttribute('value'));
      this.month = new Date(this.selected || new Date());
      this.render();
    }
  }
  get value() {
    return this.selected ? iso(this.selected) : '';
  }
  set value(value) {
    this.setAttribute('value', value || '');
  }
  open() {
    this._open = true;
    this.render();
    const trigger = this.querySelector('.date-picker-trigger');
    const popup = this.querySelector('.date-picker-popup');
    const rect = trigger.getBoundingClientRect();
    const popupHeight = popup.offsetHeight || 340;
    const top =
      window.innerHeight - rect.bottom >= popupHeight + 8 ? rect.bottom + 6 : Math.max(8, rect.top - popupHeight - 6);
    popup.style.left = `${Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8)}px`;
    popup.style.top = `${top}px`;
    popup.showPopover();
    popup.querySelector('.calendar-day[tabindex="0"]')?.focus();
  }
  close() {
    if (!this._open) return;
    this.querySelector('.date-picker-popup')?.hidePopover();
    this._open = false;
    this.render();
  }
  select(value) {
    this.selected = parse(value);
    this.setAttribute('value', value);
    this.dispatchEvent(new Event('change', { bubbles: true }));
    this.close();
  }
  move(delta) {
    this.month = new Date(this.month.getFullYear(), this.month.getMonth() + delta, 1);
    if (this._open) this.open();
    else this.render();
  }
  render() {
    const today = iso(new Date());
    const selected = this.value;
    const year = this.month.getFullYear();
    const month = this.month.getMonth();
    const first = new Date(year, month, 1);
    const days = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let blank = 0; blank < first.getDay(); blank++) cells.push('<span></span>');
    for (let day = 1; day <= days; day++) {
      const value = iso(new Date(year, month, day));
      cells.push(
        `<button type="button" class="calendar-day${value === selected ? ' selected' : ''}${value === today ? ' today' : ''}" data-date="${value}" tabindex="${value === (selected || today) ? '0' : '-1'}">${day}</button>`
      );
    }
    const display = this.selected
      ? this.selected.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : this.getAttribute('placeholder') || 'Select date';
    this.innerHTML = `<input type="hidden" name="${this.getAttribute('name') || ''}" value="${selected}" ${this.hasAttribute('required') ? 'required' : ''}>
      <button type="button" class="date-picker-trigger${selected ? ' has-value' : ''}" aria-haspopup="dialog" aria-expanded="${this._open}" aria-controls="${this._id}"><span>${display}</span><i class="fa-regular fa-calendar" aria-hidden="true"></i></button>
      <div class="date-picker-popup" id="${this._id}" popover="manual" role="dialog" aria-label="Choose date">
        <div class="calendar-header"><button type="button" data-move="-1" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><strong>${this.month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><button type="button" data-move="1" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div>
        <div class="calendar-weekdays" aria-hidden="true">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => `<span>${day}</span>`).join('')}</div>
        <div class="calendar-grid">${cells.join('')}</div>
        ${selected ? '<button type="button" class="date-picker-clear">Clear</button>' : ''}
      </div>`;
    this.querySelector('.date-picker-trigger').onclick = () => (this._open ? this.close() : this.open());
    this.querySelectorAll('[data-move]').forEach(
      (button) => (button.onclick = () => this.move(Number(button.dataset.move)))
    );
    this.querySelectorAll('[data-date]').forEach((button) => (button.onclick = () => this.select(button.dataset.date)));
    this.querySelector('.date-picker-clear')?.addEventListener('click', () => this.select(''));
    this.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
        this.querySelector('.date-picker-trigger')?.focus();
      }
    };
  }
}
customElements.define('app-datepicker', AppDatepicker);

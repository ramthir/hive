const standardDurations = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '90 minutes' },
  { value: 120, label: '2 hours' },
  { value: 180, label: '3 hours' },
  { value: 240, label: '4 hours' },
  { value: 360, label: '6 hours' },
  { value: 480, label: '8 hours' },
];
const durationLabel = (minutes) =>
  minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`;

class AppDurationpicker extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'name', 'required'];
  }
  connectedCallback() {
    this.render();
  }
  attributeChangedCallback(_name, oldValue, newValue) {
    if (oldValue !== newValue && this.isConnected) this.render();
  }
  get value() {
    return this.querySelector('app-combobox')?.value || this.getAttribute('value') || '60';
  }
  set value(value) {
    this.setAttribute('value', String(value || '60'));
  }
  render() {
    const selected = Number(this.getAttribute('value') || 60);
    const options = [...standardDurations];
    if (Number.isInteger(selected) && selected > 0 && !options.some((option) => option.value === selected))
      options.push({ value: selected, label: durationLabel(selected) });
    options.sort((left, right) => left.value - right.value);
    this.innerHTML = `<app-combobox name="${this.getAttribute('name') || ''}" value="${selected}" placeholder="Select duration" ${this.hasAttribute('required') ? 'required' : ''}>${options.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}</app-combobox>`;
  }
}
customElements.define('app-durationpicker', AppDurationpicker);

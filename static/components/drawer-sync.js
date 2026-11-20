const CUSTOM_FIELDS = 'app-combobox, app-datepicker, app-durationpicker';

// Name → value for every named control; custom pickers count as one unit.
export function snapshotForm(form) {
  const values = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.parentElement?.closest(CUSTOM_FIELDS)) continue;
    values[el.getAttribute('name')] = el.type === 'checkbox' ? el.checked : String(el.value ?? '');
  }
  return JSON.stringify(values);
}

// Decides how an open drawer reacts when its record is reloaded in the background.
export function reconcileDrawerRecord({ current, next, dirty }) {
  if (!current) return 'none';
  if (!next) return 'deleted';
  if (JSON.stringify(current) === JSON.stringify(next)) return 'none';
  return dirty ? 'conflict' : 'repopulate';
}

export function debounce(fn, wait) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

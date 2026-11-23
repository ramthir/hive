/**
 * Pandora Toast Notification System
 * A non-blocking toast notification manager styled with Monokai Pro design tokens.
 *
 * Usage:
 *   import { showToast, toast } from '/static/toast.js';
 *   showToast('Note saved successfully', 'success');
 *   toast.error('Failed to save diagram');
 *   toast.info('Copied link to clipboard');
 */

const TOAST_ICONS = {
  info: 'fa-solid fa-circle-info',
  success: 'fa-solid fa-circle-check',
  warning: 'fa-solid fa-triangle-exclamation',
  error: 'fa-solid fa-circle-exclamation',
};

const TOAST_COLORS = {
  info: 'var(--color-accent5, #78dce8)',
  success: 'var(--color-accent4, #a9dc76)',
  warning: 'var(--color-accent3, #ffd866)',
  error: 'var(--color-accent1, #ff6188)',
};

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.id = 'app-toast-container';
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-atomic', 'true');
  container.style.cssText = `
    position: fixed;
    top: var(--space-4, 1.25rem);
    right: var(--space-4, 1.25rem);
    z-index: 12000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2, 0.5rem);
    max-width: min(28rem, calc(100vw - 2.5rem));
    width: max-content;
    pointer-events: none;
  `;
  document.body.appendChild(container);
  return container;
}

/** A modal <dialog> is in the browser's top layer, above any z-index, and makes the rest of the page inert, so a toast shown while one
 *  is open goes inside it (the newest one); otherwise it lives in <body>. */
function placeContainer(parent) {
  const modals = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal'));
  const host = modals.length ? modals[modals.length - 1] : document.body;
  if (parent.parentElement !== host) host.appendChild(parent);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function showToast(message, type = 'info', duration = 3500) {
  if (!message || typeof document === 'undefined') return { dismiss: () => {} };

  const parent = ensureContainer();
  const el = document.createElement('div');
  el.className = `app-toast app-toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const accentColor = TOAST_COLORS[type] || TOAST_COLORS.info;
  const iconClass = TOAST_ICONS[type] || TOAST_ICONS.info;

  el.style.cssText = `
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    padding: 0.75rem 1rem;
    background: var(--color-dark1, #221f22);
    color: var(--color-text, #fcfcfa);
    border: 1px solid var(--color-dimmed5, #403e41);
    border-left: 3px solid ${accentColor};
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45);
    font-family: var(--font-family, Inter, sans-serif);
    font-size: 0.875rem;
    line-height: 1.4;
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
    transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  el.innerHTML = `
    <i class="${iconClass}" style="color: ${accentColor}; font-size: 1.1rem; flex-shrink: 0;" aria-hidden="true"></i>
    <span style="flex: 1; min-width: 0; word-break: break-word;">${escapeHtml(message)}</span>
    <button type="button" aria-label="Dismiss notification" style="background: none; border: none; padding: 2px 4px; color: var(--color-dimmed3, #727072); cursor: pointer; display: flex; align-items: center; font-size: 0.9rem; border-radius: 4px; transition: color 0.15s ease;">
      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
    </button>
  `;

  const closeBtn = el.querySelector('button');
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--color-accent1, #ff6188)'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--color-dimmed3, #727072)'; });

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-12px) scale(0.97)';
    setTimeout(() => { el.remove(); }, 200);
  };

  closeBtn.addEventListener('click', dismiss);

  if (duration > 0) {
    timer = setTimeout(dismiss, duration);
    el.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
    });
    el.addEventListener('mouseleave', () => {
      timer = setTimeout(dismiss, 1500);
    });
  }

  parent.appendChild(el);
  placeContainer(parent);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0) scale(1)';
  });

  return { dismiss };
}

export const toast = {
  info: (msg, dur) => showToast(msg, 'info', dur),
  success: (msg, dur) => showToast(msg, 'success', dur),
  warning: (msg, dur) => showToast(msg, 'warning', dur),
  error: (msg, dur) => showToast(msg, 'error', dur),
};

if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.toast = toast;
}

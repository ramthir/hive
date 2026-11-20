import { copyTextToClipboard } from '/static/clipboard.js';

const COPY_ICON = '<i class="fa-regular fa-copy"></i>';
const DONE_ICON = '<i class="fa-solid fa-check"></i>';

/** Add a "copy code" button to every fenced code block under `container` (once per block). */
export function setupCodeBlockActions(container) {
  container.querySelectorAll('pre code').forEach((block) => {
    const pre = block.parentElement;
    if (!pre || pre.querySelector('.notes-copy-code-btn')) return;
    const button = document.createElement('button');
    button.className = 'notes-copy-code-btn';
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy code');
    button.innerHTML = COPY_ICON;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await copyTextToClipboard(block.textContent || '');
        button.innerHTML = DONE_ICON;
        button.classList.add('copied');
        setTimeout(() => {
          button.innerHTML = COPY_ICON;
          button.classList.remove('copied');
        }, 1600);
      } catch (_error) { /* clipboard unavailable */ }
    });
    pre.appendChild(button);
  });
}

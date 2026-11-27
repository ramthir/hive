import { defineReadPage } from '/static/notes/read-page.js';
import { noteViewForPath } from '/static/notes/read-pages.js';
import { showToast } from '/static/toast.js';

function loadStyles(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', reject, { once: true });
    // Match the cascade used by the note views: their styles precede the Markdown preview.
    document.head.insertBefore(link, document.querySelector('link[href="/static/notes/preview.css"]'));
  });
}

const view = noteViewForPath(window.location.pathname);
if (view?.app) {
  const shell = document.querySelector('app-shell');
  shell.setAttribute('app', view.app);
  shell.setAttribute('active-href', view.path);
}
const shellReady = import('/static/shell.js');
if (view) {
  Promise.all([view.load(), shellReady, ...view.styles.map(loadStyles)])
    .then(([{ default: registration }]) => defineReadPage({ ...view, ...registration }))
    .catch((error) => {
      console.error('Failed to load note view:', error);
      showToast('Could not load the note view.', 'error');
    });
}

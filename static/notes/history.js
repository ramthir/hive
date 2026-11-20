import { confirmDialog } from '/static/components/dialog.js';
import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { parseUtcDate, formatRelativeTime } from '/static/time-format.js';
import { api } from '/static/notes/api.js';
import { openDialog } from '/static/notes/dialogs.js';
import { renderDiff } from '/static/notes/diff.js';

/* The note's git history: a list of versions, each openable as a diff and restorable. */

/** Open the history dialog for `slug`. `onRestored(note)` runs after a version was restored and the dialog closed. */
export async function openVersionHistory(slug, { onRestored }) {
  const base = `/notes/${encodeURIComponent(slug)}`;
  const { dialog, close } = openDialog(`
    <div class="modal-header">
      <h2 class="modal-title">History</h2>
      <div class="note-versions-header-actions">
        <button type="button" class="crud-drawer-btn" id="version-back" hidden><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> <span>All Versions</span></button>
        <button type="button" class="crud-drawer-btn primary" id="version-restore" hidden><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> <span>Restore this version</span></button>
        <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div class="modal-body">
      <p class="note-version-message" role="status" aria-live="polite"></p>
      <div class="hive-version-list" id="version-list" aria-live="polite"></div>
      <div id="version-detail" hidden></div>
    </div>`, { wide: true, className: 'note-versions-dialog-host' });
  const list = dialog.querySelector('#version-list');
  const detail = dialog.querySelector('#version-detail');
  const message = dialog.querySelector('.note-version-message');
  const back = dialog.querySelector('#version-back');
  const restore = dialog.querySelector('#version-restore');

  const showList = () => {
    detail.hidden = true;
    back.hidden = true;
    restore.hidden = true;
    list.hidden = false;
    message.textContent = '';
  };
  back.addEventListener('click', showList);

  try {
    const versions = await api(`${base}/versions`);
    list.innerHTML = versions.map((version) => `
      <button type="button" class="hive-version-row" data-sha="${esc(version.sha)}">
        <span class="msg">${esc(version.message)}</span>
        <span>${esc(version.author)}</span>
        <time datetime="${esc(version.committed_at)}" title="${esc(parseUtcDate(version.committed_at)?.toLocaleString() || '')}">${esc(formatRelativeTime(version.committed_at))}</time>
      </button>`).join('') || '<p>No history yet.</p>';
  } catch (error) {
    list.innerHTML = `<p class="note-version-message error">${esc(error.message)}</p>`;
    return;
  }

  list.addEventListener('click', async (event) => {
    const row = event.target.closest('.hive-version-row');
    if (!row) return;
    try {
      const sha = row.dataset.sha;
      const { diff } = await api(`${base}/versions/${sha}/diff`);
      list.hidden = true;
      detail.hidden = false;
      back.hidden = false;
      restore.hidden = false;
      detail.innerHTML = `<p style="margin-bottom:.5rem">${esc(row.querySelector('.msg').textContent)} · <code>${esc(sha.slice(0, 7))}</code></p><pre class="hive-diff">${renderDiff(diff)}</pre>`;
      restore.onclick = async () => {
        const confirmed = await confirmDialog({
          title: 'Restore this version?',
          message: 'The note is set back to this version and saved as a new commit. Newer history is kept.',
          confirmText: 'Restore',
          cancelText: 'Cancel',
        });
        if (!confirmed) return;
        try {
          // The restored title can differ from the current one, in which case the file gets its old name back.
          const restored = await api(`${base}/versions/${sha}/restore`, { method: 'POST' });
          close();
          showToast('Version restored', 'success');
          onRestored(restored);
        } catch (error) {
          message.className = 'note-version-message error';
          message.textContent = error.message;
        }
      };
    } catch (error) {
      message.className = 'note-version-message error';
      message.textContent = error.message || 'Could not open version.';
    }
  });
}

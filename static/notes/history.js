import { confirmDialog } from '/static/components/dialog.js';
import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { api } from '/static/notes/api.js';
import { openDialog } from '/static/notes/dialogs.js';
import '/static/components/tab-bar.js';
import { FILTERS, filterTabs, renderVersionList } from '/static/notes/history-list.js';
import { COMPARE_TABS, positionLabel, renderVersionDetail, restoreDetails, restoreTitle } from '/static/notes/history-detail.js';

/* The note's git history: a timeline of versions, each openable as a diff and restorable. */

/** Open the history dialog for `slug`. `onRestored(note)` runs after a version was restored and the dialog closed. */
export async function openVersionHistory(slug, { onRestored }) {
  const base = `/notes/${encodeURIComponent(slug)}`;
  const { dialog, close } = openDialog(`
    <div class="modal-header modal-header--tabs">
      <h2 class="modal-title">History</h2>
      <app-tab-bar id="version-tabs" size="drawer" aria-label="Kind of change"></app-tab-bar>
      <div class="note-versions-header-actions">
        <button type="button" class="crud-drawer-btn" id="version-back" hidden><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> <span>All versions</span></button>
        <span class="hive-version-position" id="version-position" aria-live="polite" hidden></span>
        <button type="button" class="hive-version-step" id="version-older" aria-label="Older version" hidden><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
        <button type="button" class="hive-version-step" id="version-newer" aria-label="Newer version" hidden><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div class="modal-body">
      <p class="note-version-message" role="status" aria-live="polite"></p>
      <div class="hive-version-list" id="version-list" role="tabpanel" aria-live="polite"></div>
      <div id="version-detail" hidden></div>
    </div>
    <div class="modal-footer hive-version-footer" id="version-footer" hidden>
      <p>Restoring saves this version as a new one. Nothing is deleted.<br><span class="keys">← older · → newer · Esc back</span></p>
      <button type="button" class="crud-drawer-btn primary" id="version-restore"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> <span>Restore this version</span></button>
    </div>`, { wide: true, className: 'note-versions-dialog-host' });
  const list = dialog.querySelector('#version-list');
  const detail = dialog.querySelector('#version-detail');
  const message = dialog.querySelector('.note-version-message');
  const back = dialog.querySelector('#version-back');
  const restore = dialog.querySelector('#version-restore');
  const footer = dialog.querySelector('#version-footer');
  const position = dialog.querySelector('#version-position');
  const older = dialog.querySelector('#version-older');
  const newer = dialog.querySelector('#version-newer');
  const filters = dialog.querySelector('#version-tabs');
  filters.tabs = filterTabs();
  filters.active = 'all';
  const filterNote = document.createElement('p');
  filterNote.className = 'hive-version-filter-note';
  filterNote.hidden = true;

  let open = null; // { sha, row, label, committedAt } of the version in the detail view
  let info = null; // the last diff response for it
  let filter = 'all';
  const showError = (error, fallback) => {
    message.className = 'note-version-message error';
    message.textContent = error?.message || fallback;
  };

  // The list loads a page at a time; a full page means there may be more behind "Load older versions".
  const PAGE = 30;
  let loaded = [];
  let hasMore = false;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'crud-drawer-btn hive-version-more';
  more.textContent = 'Load older versions';
  more.hidden = true;
  list.after(more);
  more.after(filterNote);

  const visibleRows = () => [...list.querySelectorAll('.hive-version-row:not([hidden])')];

  /** Show only the rows of one kind (and the day headings that still have a row). Filters what is loaded so far. */
  const applyFilter = () => {
    let heading = null;
    let shown = 0;
    for (const el of list.children) {
      if (el.matches('.hive-version-day')) {
        if (heading) heading.hidden = !shown;
        heading = el;
        shown = 0;
      } else if (el.matches('.hive-version-row')) {
        el.hidden = filter !== 'all' && !(el.dataset.kinds || '').split(' ').includes(FILTERS.find((f) => f.id === filter).kind);
        if (!el.hidden) shown += 1;
      }
    }
    if (heading) heading.hidden = !shown;
    const visible = visibleRows().length;
    filterNote.hidden = filter === 'all';
    filterNote.textContent = `${visible ? `${visible} shown` : 'Nothing matches'} among the ${loaded.length} loaded versions${hasMore ? '. Load older versions to search further.' : '.'}`;
  };
  filters.addEventListener('tab-switch', (event) => {
    filter = event.detail.tab;
    applyFilter();
  });

  const showList = () => {
    filters.hidden = false;
    filterNote.hidden = filter === 'all';
    detail.hidden = true;
    for (const el of [back, position, older, newer, footer]) el.hidden = true;
    list.hidden = false;
    more.hidden = !hasMore;
    message.textContent = '';
  };
  back.addEventListener('click', () => { showList(); open?.row.focus(); });

  const loadPage = async () => {
    const page = await api(`${base}/versions?limit=${PAGE}&offset=${loaded.length}`);
    const html = renderVersionList(page, new Date(), loaded[loaded.length - 1]);
    if (!loaded.length) list.innerHTML = html || '<p>No history yet.</p>';
    else list.insertAdjacentHTML('beforeend', html);
    loaded = loaded.concat(page);
    hasMore = page.length === PAGE;
    more.hidden = !hasMore;
    applyFilter();
  };
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      await loadPage();
    } catch (error) {
      showError(error, 'Could not load more versions.');
    } finally {
      more.disabled = false;
    }
  });

  try {
    await loadPage();
  } catch (error) {
    list.innerHTML = `<p class="note-version-message error">${esc(error.message)}</p>`;
    return;
  }

  /** A version's sha can change under the open dialog (Codex rewords a commit message). Reload the pages shown so far and
   * point `open` at the same version again, found by its commit time. False if it is gone. */
  const refreshOpen = async () => {
    const wasAt = open.committedAt;
    const index = loaded.findIndex((version) => version.sha === open.sha);
    const count = Math.max(loaded.length, PAGE);
    const page = await api(`${base}/versions?limit=${count}`);
    loaded = page;
    list.innerHTML = renderVersionList(page) || '<p>No history yet.</p>';
    hasMore = page.length === count;
    applyFilter();
    const same = page.filter((version) => version.committed_at === wasAt);
    const found = same.find((version) => page.indexOf(version) === index) || same[0];
    if (!found) return false;
    const row = list.querySelector(`.hive-version-row[data-sha="${found.sha}"]`);
    open = { sha: found.sha, row, label: found.summary || found.message, committedAt: found.committed_at };
    return true;
  };

  /** Run `call`; if the open version's sha is gone (404), refresh it once and run `call` again. */
  const withFreshSha = async (call) => {
    try {
      return await call();
    } catch (error) {
      if (error.status !== 404 || !open || !(await refreshOpen())) throw error;
      return call();
    }
  };

  const openVersionData = () => loaded.find((version) => version.sha === open.sha);

  /** Draw the open version against its previous version, or against the note as it is now. */
  const showDiff = async (against) => {
    info = await withFreshSha(() => api(`${base}/versions/${open.sha}/diff?against=${against}`));
    detail.innerHTML = renderVersionDetail(openVersionData(), against, info);
    const compare = detail.querySelector('.hive-vd-compare');
    compare.tabs = COMPARE_TABS;
    compare.active = against;
    position.textContent = positionLabel(info);
    const rows = visibleRows();
    const at = rows.indexOf(open.row);
    older.disabled = at < 0 || (at === rows.length - 1 && !hasMore);
    newer.disabled = at <= 0;
  };
  detail.addEventListener('tab-switch', async (event) => {
    if (!open) return;
    try {
      await showDiff(event.detail.tab);
    } catch (error) {
      showError(error, 'Could not load the comparison.');
    }
  });

  /** Open the version in row `row`: properties and text against its previous version, with Restore and the toggle. */
  const openVersion = async (row) => {
    try {
      const sha = row.dataset.sha;
      open = { sha, row, label: row.querySelector('.msg').textContent, committedAt: loaded.find((version) => version.sha === sha)?.committed_at };
      await showDiff('previous');
      list.hidden = true;
      filters.hidden = true;
      filterNote.hidden = true;
      more.hidden = true;
      detail.hidden = false;
      for (const el of [back, position, older, newer, footer]) el.hidden = false;
      message.textContent = '';
      detail.tabIndex = -1;
      detail.focus({ preventScroll: true }); // the clicked row is hidden now; keep keys inside the dialog
    } catch (error) {
      showError(error, 'Could not open version.');
    }
  };

  /** Step to the older (+1) or newer (-1) version; at the end of the loaded pages, older loads the next page. */
  const step = async (direction) => {
    if (!open) return;
    let rows = visibleRows();
    if (direction > 0 && rows.indexOf(open.row) === rows.length - 1 && hasMore) {
      try {
        await loadPage();
      } catch (error) {
        showError(error, 'Could not load more versions.');
        return;
      }
      rows = visibleRows();
    }
    const next = rows[rows.indexOf(open.row) + direction];
    if (next) openVersion(next);
  };
  older.addEventListener('click', () => step(1));
  newer.addEventListener('click', () => step(-1));

  restore.addEventListener('click', async () => {
    if (!open || !info) return;
    const confirmed = await confirmDialog({
      title: restoreTitle(openVersionData()),
      message: 'Set the note back to this version?',
      details: restoreDetails(info),
      icon: 'fa-rotate-left',
      confirmText: 'Restore',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      // The restored title can differ from the current one, in which case the file gets its old name back.
      const restored = await withFreshSha(() => api(`${base}/versions/${open.sha}/restore`, { method: 'POST' }));
      close();
      showToast('Version restored', 'success');
      onRestored(restored);
    } catch (error) {
      showError(error, 'Could not restore.');
    }
  });

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.hive-version-row');
    if (row) openVersion(row);
  });

  // Esc steps back to the list before it closes the dialog; Left / Right step to the older / newer version.
  // On window, in the capture phase: the dialog's own Escape handler is on document and would close it first.
  const onKey = (event) => {
    if (!dialog.isConnected) { window.removeEventListener('keydown', onKey, true); return; }
    if (detail.hidden || !open) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      event.preventDefault();
      showList();
      open.row.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? 1 : -1);
    }
  };
  window.addEventListener('keydown', onKey, true);
}

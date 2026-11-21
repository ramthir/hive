import { confirmDialog } from '/static/components/dialog.js';
import { showToast } from '/static/toast.js';
import { escapeHtml as esc } from '/static/html.js';
import { api } from '/static/notes/api.js';
import { openDialog } from '/static/notes/dialogs.js';
import '/static/components/tab-bar.js';
import { FILTERS, filterTabs, renderVersionList } from '/static/notes/history-list.js';
import { COMPARE_TABS, positionLabel, renderVersionDetail, renderVersionPending, restoreDetails, restoreTitle } from '/static/notes/history-detail.js';

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
        <button type="button" class="modal-icon-btn" id="version-older" aria-label="Older version" hidden><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
        <button type="button" class="modal-icon-btn" id="version-newer" aria-label="Newer version" hidden><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="modal-close-btn" data-dialog-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div class="modal-body">
      <p class="note-version-message" role="status" aria-live="polite"></p>
      <div class="hive-version-list" id="version-list" role="tabpanel"></div>
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

  const visibleRows = () => [...list.querySelectorAll('.hive-version-row:not([hidden]):not([disabled])')];

  /** Draw the rail between the centres of the first and the last circle: not above the first nor below the last. */
  const updateRail = () => {
    const icons = [...list.querySelectorAll('.hive-version-row:not([hidden]) .hive-version-icon')];
    if (icons.length < 2 || list.hidden) {
      list.style.setProperty('--rail-height', '0px');
      return;
    }
    const top = list.getBoundingClientRect().top - list.scrollTop;
    const centre = (icon) => { const rect = icon.getBoundingClientRect(); return rect.top - top + rect.height / 2; };
    list.style.setProperty('--rail-top', `${centre(icons[0])}px`);
    list.style.setProperty('--rail-height', `${centre(icons[icons.length - 1]) - centre(icons[0])}px`);
  };
  new ResizeObserver(updateRail).observe(list); // rows wrap differently when the drawer is resized

  // The server filters (a kind's versions can be far apart in a long history), so a filter is a new list, not hidden rows.
  const kindQuery = () => {
    const kind = FILTERS.find((candidate) => candidate.id === filter).kind;
    return kind ? `&kind=${encodeURIComponent(kind)}` : '';
  };
  const emptyText = () => (filter === 'all' ? 'No history yet.' : 'No changes of this kind in the history.');
  const skeleton = '<div class="hive-version-loading" aria-hidden="true">' + '<span class="hive-vd-skeleton-row"><i></i><b><i></i><i></i></b></span>'.repeat(4) + '</div>';
  let turn = 0; // which list is current: a page of a filter the reader has left is dropped
  filters.addEventListener('tab-switch', async (event) => {
    filter = event.detail.tab;
    const mine = ++turn;
    loaded = [];
    hasMore = false;
    more.hidden = true;
    list.innerHTML = skeleton;
    list.setAttribute('aria-busy', 'true');
    updateRail();
    try {
      await loadPage();
    } catch (error) {
      if (mine === turn) list.innerHTML = `<p class="note-version-message error">${esc(error.message)}</p>`;
    } finally {
      if (mine === turn) list.removeAttribute('aria-busy');
    }
  });

  const showList = () => {
    filters.hidden = false;
    detail.hidden = true;
    for (const el of [back, position, older, newer, footer]) el.hidden = true;
    list.hidden = false;
    updateRail();
    more.hidden = !hasMore;
    message.textContent = '';
  };
  back.addEventListener('click', () => { showList(); open?.row.focus(); });

  const loadPage = async () => {
    const mine = turn;
    const page = await api(`${base}/versions?limit=${PAGE}&offset=${loaded.length}${kindQuery()}`);
    if (mine !== turn) return;
    const html = renderVersionList(page, new Date(), loaded[loaded.length - 1]);
    if (!loaded.length) list.innerHTML = html || `<p>${emptyText()}</p>`; // also replaces the loading placeholder
    else list.insertAdjacentHTML('beforeend', html);
    loaded = loaded.concat(page);
    hasMore = page.length === PAGE;
    more.hidden = !hasMore;
    updateRail();
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

  list.innerHTML = skeleton;
  list.setAttribute('aria-busy', 'true');
  try {
    await loadPage();
    list.removeAttribute('aria-busy');
  } catch (error) {
    list.removeAttribute('aria-busy');
    list.innerHTML = `<p class="note-version-message error">${esc(error.message)}</p>`;
    return;
  }

  /** A version's sha can change under the open dialog (Codex rewords a commit message). Reload the pages shown so far and
   * point `open` at the same version again, found by its commit time. False if it is gone. */
  const refreshOpen = async () => {
    const wasAt = open.committedAt;
    const index = loaded.findIndex((version) => version.sha === open.sha);
    const count = Math.max(loaded.length, PAGE);
    const page = await api(`${base}/versions?limit=${count}${kindQuery()}`);
    loaded = page;
    diffs.clear();
    list.innerHTML = renderVersionList(page) || `<p>${emptyText()}</p>`;
    hasMore = page.length === count;
    updateRail();
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

  // Diffs already fetched (or being fetched), by version and comparison: a version never changes, so opening one again,
  // stepping to a neighbour or hovering a row before the click costs no round trip.
  const diffs = new Map();
  const fetchDiff = (sha, against) => {
    const key = `${sha}|${against}`;
    if (!diffs.has(key)) {
      const request = api(`${base}/versions/${sha}/diff?against=${against}`);
      diffs.set(key, request);
      request.catch(() => diffs.delete(key));
    }
    return diffs.get(key);
  };
  let drawing = 0; // which draw is the latest: an older response that arrives late is dropped

  /** Draw the open version against its previous version, or against the note as it is now. */
  const showDiff = async (against) => {
    const turn = ++drawing;
    const result = await withFreshSha(() => fetchDiff(open.sha, against));
    if (turn !== drawing) return; // another version was opened meanwhile
    info = result;
    detail.innerHTML = renderVersionDetail(openVersionData(), against, info);
    const compare = detail.querySelector('.hive-vd-compare');
    compare.tabs = COMPARE_TABS;
    compare.active = against;
    detail.removeAttribute('aria-busy');
    position.textContent = positionLabel(info);
    updateStepButtons();
    prefetchNeighbours();
  };
  const updateStepButtons = () => {
    const rows = visibleRows();
    const at = rows.indexOf(open.row);
    older.disabled = at < 0 || (at === rows.length - 1 && !hasMore);
    newer.disabled = at <= 0;
  };
  /** Fetch the diffs of the versions either side while the reader looks at this one. */
  const prefetchNeighbours = () => {
    const rows = visibleRows();
    const at = rows.indexOf(open.row);
    for (const row of [rows[at + 1], rows[at - 1]]) if (row) fetchDiff(row.dataset.sha, 'previous').catch(() => {});
  };
  detail.addEventListener('tab-switch', async (event) => {
    if (!open) return;
    try {
      await showDiff(event.detail.tab);
    } catch (error) {
      showError(error, 'Could not load the comparison.');
    }
  });

  // Hovering a row for a moment fetches its diff, so the click that follows has it already.
  let hoverTimer = 0;
  list.addEventListener('pointerover', (event) => {
    const row = event.target.closest('.hive-version-row:not([disabled])');
    clearTimeout(hoverTimer);
    if (row) hoverTimer = setTimeout(() => fetchDiff(row.dataset.sha, 'previous').catch(() => {}), 120);
  });
  list.addEventListener('pointerleave', () => clearTimeout(hoverTimer));

  /** Open the version in row `row` at once, with its summary and a placeholder, and fill in the changes as they arrive. */
  const openVersion = async (row) => {
    const sha = row.dataset.sha;
    const version = loaded.find((candidate) => candidate.sha === sha);
    open = { sha, row, label: row.querySelector('.msg').textContent, committedAt: version?.committed_at };
    info = null;
    list.hidden = true;
    filters.hidden = true;
    more.hidden = true;
    detail.hidden = false;
    for (const el of [back, position, older, newer, footer]) el.hidden = false;
    position.textContent = '';
    older.disabled = true;
    newer.disabled = true;
    restore.disabled = true;
    message.textContent = '';
    if (!diffs.has(`${sha}|previous`)) { // not fetched yet: show the summary and a placeholder while it loads
      detail.innerHTML = renderVersionPending(version);
      detail.setAttribute('aria-busy', 'true');
    }
    detail.tabIndex = -1;
    detail.focus({ preventScroll: true }); // the clicked row is hidden now; keep keys inside the dialog
    try {
      await showDiff('previous');
      restore.disabled = false;
    } catch (error) {
      showList();
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
      diffs.clear();
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
    // Another dialog (the restore confirmation) is on top: the keys are its own.
    if ([...document.querySelectorAll('app-dialog:not(.is-hidden)')].at(-1) !== dialog) return;
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

import { escapeHtml as esc } from '/static/html.js';
import { showToast } from '/static/toast.js';
import { api } from '/static/notes/api.js';
import { openDialog, dialogHeader } from '/static/notes/dialogs.js';
import { readPagePath } from '/static/notes/read-pages.js';

/** Resolve all `.notes-wikilink` elements under `root` against `/api/resolve`. */
export async function decorateWikilinks(root, onResolved) {
  const links = [...root.querySelectorAll('.notes-wikilink')];
  const targets = [...new Set(links.map((link) => link.dataset.target).filter((target) => target && !target.startsWith('#')))];
  for (const link of links) if (link.dataset.target?.startsWith('#')) link.classList.remove('unresolved');
  if (!targets.length) return;
  let resolved;
  try {
    resolved = await api(`/resolve?${targets.map((target) => `target=${encodeURIComponent(target)}`).join('&')}`);
  } catch (error) {
    console.error('Failed to resolve wikilinks:', error);
    return;
  }
  if (!root.isConnected) return;
  for (const link of links) {
    const hit = resolved[link.dataset.target];
    if (!hit) {
      if (!link.dataset.target.startsWith('#')) link.classList.add('unresolved');
      continue;
    }
    link.classList.remove('unresolved');
    link.dataset.slug = hit.slug;
    // Straight to the read page of a table, task, meeting...: going through /notes/{slug} only to be sent on is a second page load.
    link.dataset.path = readPagePath({ slug: hit.slug, types: hit.types }) || `/notes/${encodeURIComponent(hit.slug)}`;
    link.setAttribute('href', link.dataset.path);
    if (link.dataset.autoLabel === 'true') link.textContent = hit.title;
    onResolved?.(link, hit);
  }
}

/** Prompt to create a missing note from an unresolved `[[target]]` wikilink. */
export function promptCreateNote(target, { onCreated, onError } = {}) {
  const title = target.split('#', 1)[0].trim();
  if (!title) return;
  const { dialog, close } = openDialog(`
    ${dialogHeader('Create Note')}
    <div class="modal-body">Note &ldquo;<strong>${esc(title)}</strong>&rdquo; does not exist yet. Would you like to create it?</div>
    <div class="modal-footer">
      <button type="button" class="crud-drawer-btn" data-action="cancel">Cancel</button>
      <button type="button" class="crud-drawer-btn primary" data-action="confirm-create"><i class="fa-solid fa-plus" aria-hidden="true"></i> Create Note</button>
    </div>`, { initialFocus: '[data-action="confirm-create"]' });
  dialog.querySelector('[data-action="confirm-create"]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const created = await api('/notes', { method: 'POST', body: { content: `# ${title}\n\n`, tags: [] } });
      close();
      onCreated?.(created);
    } catch (error) {
      button.disabled = false;
      if (onError) onError(error);
      else showToast(error.message || 'Could not create note.', 'error');
    }
  });
}

/** Handle a click on a `.notes-wikilink` element, resolving on demand if `/resolve` is still in flight. */
export async function handleWikilinkClick(event, { onNavigate, onCreate, stopPropagation = false } = {}) {
  const link = event.target.closest?.('.notes-wikilink');
  if (!link) return;
  const target = link.dataset.target || '';
  if (target.startsWith('#') && !link.dataset.slug) return;
  event.preventDefault();
  if (stopPropagation) event.stopPropagation();
  if (link.classList.contains('unresolved')) {
    onCreate?.(target);
    return;
  }
  const open = event.metaKey || event.ctrlKey || event.button === 1;
  let url = link.dataset.path || (link.dataset.slug ? `/notes/${encodeURIComponent(link.dataset.slug)}` : '');
  if (!url) {
    if (!target || link.dataset.resolving) return;
    link.dataset.resolving = '1';
    let hit = null;
    try {
      hit = (await api(`/resolve?target=${encodeURIComponent(target)}`))[target];
    } catch { /* reported below */ } finally {
      delete link.dataset.resolving;
    }
    if (!hit) { showToast(`Could not open "${target}".`, 'error'); return; }
    url = readPagePath(hit) || `/notes/${encodeURIComponent(hit.slug)}`;
  }
  if (open) window.open(url, '_blank');
  else onNavigate(url);
}

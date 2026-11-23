import { api } from '/static/notes/api.js';
import { showToast } from '/static/toast.js';
import { copyTextToClipboard } from '/static/clipboard.js';
import { streamUrlPath } from '/static/iptv/format.js';

/** A tick in place of the copy icon for a moment. */
function flash(button) {
  const icon = button.querySelector('i');
  if (!icon) return;
  icon.className = 'fa-solid fa-check';
  button.classList.add('is-copied');
  setTimeout(() => { icon.className = 'fa-regular fa-copy'; button.classList.remove('is-copied'); }, 1500);
}

/** A button with data-type, data-id (and data-episode): ask the server for that stream's URL (it holds the account's password, so it is
 *  not in the page) and put it on the clipboard. */
export async function copyStreamUrl(button) {
  const { type, id, episode } = button.dataset;
  try {
    const { url } = await api(streamUrlPath(type, id, episode));
    await copyTextToClipboard(url);
    flash(button);
    showToast('Stream URL copied. Open in VLC Network Stream.');
  } catch (error) {
    showToast(error.message || 'Could not copy the URL');
  }
}

import { escapeHtml as esc } from '/static/html.js';
import '/static/components/tab-bar.js';
import { api } from '/static/notes/api.js';
import { dialogHeader, openDialog } from '/static/notes/dialogs.js';
import { copyStreamUrl } from '/static/iptv/copy.js';
import { durationLabel, episodeLabel, initials, parseTitle, pickSeason, seriesFacts, titleHue } from '/static/iptv/format.js';

/* A series in a drawer beside the list: the provider's facts and plot, and its episodes by season, each with a button that copies the
   episode's stream URL to open in a player such as VLC. Opened from a series card in the Library. */

/** Open the drawer for the series `id` (its provider id) called `name`. */
export async function openSeriesDrawer({ id, name }) {
  const { title } = parseTitle(name);
  const { dialog } = openDialog(`${dialogHeader(title)}<div class="modal-body iptv-drawer-body"><p class="iptv-status" role="status">Loading…</p></div>`, {
    wide: true, className: 'iptv-series-drawer',
  });
  const body = dialog.querySelector('.iptv-drawer-body');
  dialog.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) { e.preventDefault(); copyStreamUrl(copy); }
  });
  let series;
  try {
    series = await api(`/iptv/series/${encodeURIComponent(id)}`);
  } catch (error) {
    body.innerHTML = `<p class="iptv-empty">${esc(error.status === 404 ? 'This series is not in the catalogue.' : error.message || 'Could not load the series')}</p>`;
    return;
  }
  const { info, seasons } = series;
  const label = (e) => episodeLabel(e, title); // the provider's titles often repeat the series name
  const facts = seriesFacts(info);
  const rows = [['Genre', info.genre], ['Cast', info.cast], ['Director', info.director]].filter(([, v]) => v);
  body.innerHTML = `
    <div class="iptv-hero">
      <span class="iptv-hero-art iptv-art" style="--hue:${titleHue(title)}"><span class="iptv-initials" aria-hidden="true">${esc(initials(title))}</span>${info.poster ? `<img src="${esc(info.poster)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}</span>
      <div class="iptv-hero-text">
        ${facts.length ? `<p class="iptv-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</p>` : ''}
        ${info.plot ? `<p class="iptv-plot">${esc(info.plot)}</p>` : ''}
        ${rows.length ? `<dl class="iptv-meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        ${info.trailer_url ? `<a class="iptv-trailer" href="${esc(info.trailer_url)}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-youtube" aria-hidden="true"></i> Trailer</a>` : ''}
      </div>
    </div>
    ${seasons.length ? '<app-tab-bar class="iptv-seasons" aria-label="Seasons"></app-tab-bar><ul class="iptv-episode-list"></ul>' : '<p class="iptv-empty">The provider lists no episodes for this series.</p>'}`;
  if (!seasons.length) return;
  const list = body.querySelector('.iptv-episode-list');
  const show = (number) => {
    const season = pickSeason(seasons, number);
    list.innerHTML = season.episodes.map((e) => {
      const length = durationLabel(e.duration);
      return `<li class="iptv-episode">
        <span class="iptv-episode-thumb">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : `<span>${e.number}</span>`}</span>
        <span class="iptv-episode-text"><span class="iptv-episode-title">${esc(label(e))}${length ? `<span class="iptv-episode-length">${esc(length)}</span>` : ''}</span>${e.plot ? `<span class="iptv-episode-plot">${esc(e.plot)}</span>` : ''}</span>
        <button type="button" class="iptv-episode-copy" data-copy data-type="series" data-id="${esc(series.id)}" data-episode="${esc(e.id)}" aria-label="Copy the stream URL of ${esc(label(e))}" title="Copy stream URL"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>
      </li>`;
    }).join('');
  };
  const bar = body.querySelector('.iptv-seasons');
  bar.tabs = Object.fromEntries(seasons.map((s) => [String(s.number), { label: s.name }]));
  bar.active = String(seasons[0].number);
  bar.addEventListener('tab-switch', ({ detail }) => show(Number(detail.tab)));
  show(seasons[0].number);
}

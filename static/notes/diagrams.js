/* PlantUML previews: ```plantuml / ```puml fences become figures that show the rendered image once known. */

const EMBED = /^\/notes\/([A-Za-z0-9._-]+)\/diagram\.(svg|png)(\?[^#]*)?$/;

/** The slug an image address embeds (`/notes/<slug>/diagram.svg?n=2`), or null for any other address. */
export function embedSlug(src) {
  return EMBED.exec(src || '')?.[1] ?? null;
}

/** The embed address with `v=<revision>` (replacing an author's own `v`), so a changed note is fetched again and an unchanged one is kept. */
export function versionedEmbed(src, revision) {
  const m = EMBED.exec(src || '');
  if (!m || !revision) return src;
  const query = new URLSearchParams(m[3] || '');
  query.set('v', revision);
  return `/notes/${m[1]}/diagram.${m[2]}?${query}`;
}

/** The PNG address of an embed (`/notes/<slug>/diagram.png?n=2&theme=light`), keeping its `n` and `v`; null for any other address. */
export function embedPngUrl(src, theme) {
  const m = EMBED.exec(src || '');
  if (!m) return null;
  const query = new URLSearchParams(m[3] || '');
  query.set('theme', theme);
  return `/notes/${m[1]}/diagram.png?${query}`;
}

/** The download name of an embed: its alt text, else `<slug>-<n>`. */
export function embedFileName(src, alt) {
  const m = EMBED.exec(src || '');
  const n = new URLSearchParams(m?.[3] || '').get('n') || '1';
  return String(alt || '').trim() || `${m?.[1] || 'diagram'}-${n}`;
}

export class DiagramPreviews {
  /** `render(source)` resolves to `{ svg }` or rejects with an error that may carry `status`.
   *  `revision(slug)` resolves to the note's revision (for the embeds' `v=`); without it embeds load unversioned. */
  constructor(render, revision = null) {
    this.render = render;
    this.revision = revision;
    this.versioned = new Map(); // embed address -> address with v=, so a redraw (every keystroke) does not look again
    this.cache = new Map();
    this.errors = new Map();
    this.inflight = new Map();
    this.timer = null;
  }

  dispose() {
    clearTimeout(this.timer);
  }

  image(doc, dataUrl) {
    const img = doc.createElement('img');
    img.className = 'notes-diagram-img';
    img.alt = 'PlantUML diagram';
    img.setAttribute('src', dataUrl); // an <img> never runs script, even if the SVG contained some
    return img;
  }

  // The rendered diagram plus a kebab menu with "Download PNG" in dark and light. Markup only: the page
  // listens for the menu's `dropdown-select` (the figure may be re-parsed from HTML, which loses listeners).
  content(doc, figure, dataUrl) {
    return [this.image(doc, dataUrl), this.tools(doc)];
  }

  tools(doc) {
    const tools = doc.createElement('div');
    tools.className = 'notes-diagram-tools';
    tools.innerHTML = `<app-dropdown-menu class="diagram-download-menu" placement="bottom-end">
      <button slot="trigger" type="button" class="notes-diagram-download" title="Diagram actions" aria-label="Diagram actions"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>
      <div slot="menu">
        <div class="notes-diagram-menu-title">Download PNG</div>
        <button class="app-dropdown-item notes-menu-item" type="button" data-download-theme="dark"><i class="fa-regular fa-moon" aria-hidden="true"></i><span>Dark Theme</span></button>
        <button class="app-dropdown-item notes-menu-item" type="button" data-download-theme="light"><i class="fa-regular fa-sun" aria-hidden="true"></i><span>Light Theme</span></button>
      </div></app-dropdown-menu>`;
    return tools;
  }

  // Replace each plantuml fence in the parsed document by a figure: the image if known, else the code with a status line.
  markBlocks(parsed) {
    parsed.querySelectorAll('pre > code.language-plantuml, pre > code.language-puml').forEach((code) => {
      const pre = code.parentElement;
      const source = code.textContent.trim();
      if (!source) return;
      const figure = parsed.createElement('figure');
      figure.className = 'notes-diagram';
      figure.setAttribute('data-diagram', source);
      const image = this.cache.get(source);
      const error = this.errors.get(source);
      if (image) {
        figure.append(...this.content(parsed, figure, image));
      } else {
        figure.appendChild(pre.cloneNode(true));
        const note = parsed.createElement('p');
        note.className = error ? 'notes-diagram-error' : 'notes-diagram-status';
        note.textContent = error || 'Rendering diagram…';
        figure.appendChild(note);
      }
      pre.replaceWith(figure);
    });
  }

  // `![](/notes/<slug>/diagram.svg?n=2)`: held back (no src) until the note's revision is known, so the image loads once, with `v=`.
  // Wrapped like a fenced diagram (a figure with the Download PNG menu, `data-embed` naming the address); an image alone in its
  // paragraph replaces the paragraph (a figure cannot sit in a <p>), one inside text gets an inline wrapper.
  markEmbeds(parsed) {
    parsed.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (!embedSlug(src)) return;
      img.classList.add('notes-diagram-img', 'notes-diagram-embed');
      img.setAttribute('data-embed', src);
      img.removeAttribute('src');
      if (this.versioned.has(src)) img.setAttribute('src', this.versioned.get(src));
      const parent = img.parentElement;
      const alone = parent?.tagName === 'P' && parent.childNodes.length === [...parent.childNodes].filter((node) => node === img || (node.nodeType === 3 && !node.textContent.trim())).length;
      const figure = parsed.createElement(alone ? 'figure' : 'span');
      figure.className = alone ? 'notes-diagram' : 'notes-diagram notes-diagram-inline';
      figure.setAttribute('data-embed', src);
      (alone ? parent : img).replaceWith(figure);
      figure.append(img, this.tools(parsed));
    });
  }

  async loadEmbeds(preview) {
    const pending = [...preview.querySelectorAll('img[data-embed]:not([src])')];
    if (!pending.length) return;
    const revisions = new Map();
    await Promise.all([...new Set(pending.map((img) => embedSlug(img.dataset.embed)))].map(async (slug) => {
      try { revisions.set(slug, await this.revision?.(slug)); } catch (_error) { /* shown unversioned; the image reports its own error */ }
    }));
    pending.forEach((img) => {
      const src = img.dataset.embed;
      const next = versionedEmbed(src, revisions.get(embedSlug(src)));
      this.versioned.set(src, next);
      if (this.versioned.size > 200) this.versioned.delete(this.versioned.keys().next().value);
      img.addEventListener('error', () => {
        const note = img.ownerDocument.createElement('p');
        note.className = 'notes-diagram-error';
        note.textContent = `Could not load this diagram (${img.getAttribute('alt') || embedSlug(src)}): the note, the diagram number or PlantUML is missing.`;
        (img.closest('.notes-diagram[data-embed]') || img).replaceWith(note);
      }, { once: true });
      img.setAttribute('src', next);
    });
  }

  // Fetch whatever is not rendered yet. While typing, wait for a pause so each keystroke does not start a render.
  decorate(preview, { editing = false } = {}) {
    const pending = [...preview.querySelectorAll('.notes-diagram[data-diagram]')]
      .filter((figure) => !figure.querySelector('.notes-diagram-img') && !this.errors.has(figure.dataset.diagram));
    if (!pending.length) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const sources = [...new Set(pending.map((figure) => figure.dataset.diagram))];
      await Promise.all(sources.map((source) => this.fetch(source)));
      this.apply(preview);
    }, editing ? 500 : 0);
  }

  async fetch(source) {
    if (this.cache.has(source) || this.errors.has(source)) return;
    if (!this.inflight.has(source)) {
      const request = this.render(source)
        .then(({ svg }) => {
          this.cache.set(source, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
          if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
        })
        .catch((error) => {
          this.errors.set(source, error.status === 503 ? `PlantUML is not set up: ${error.message}` : `Could not render this diagram: ${error.message}`);
        })
        .finally(() => this.inflight.delete(source));
      this.inflight.set(source, request);
    }
    await this.inflight.get(source);
  }

  // Swap each figure under `preview` to its image, or show its error under the code.
  apply(preview) {
    if (!preview) return;
    preview.querySelectorAll('.notes-diagram[data-diagram]').forEach((figure) => {
      if (figure.querySelector('.notes-diagram-img')) return;
      const source = figure.dataset.diagram;
      const image = this.cache.get(source);
      const error = this.errors.get(source);
      if (image) {
        figure.replaceChildren(...this.content(figure.ownerDocument, figure, image));
      } else if (error) {
        const status = figure.querySelector('.notes-diagram-status, .notes-diagram-error');
        if (status) {
          status.className = 'notes-diagram-error';
          status.textContent = error;
        }
      }
    });
  }
}

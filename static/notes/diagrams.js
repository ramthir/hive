/* PlantUML previews: ```plantuml / ```puml fences become figures that show the rendered image once known. */

export class DiagramPreviews {
  /** `render(source)` resolves to `{ svg }` or rejects with an error that may carry `status`. */
  constructor(render) {
    this.render = render;
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
        figure.appendChild(this.image(parsed, image));
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
        figure.replaceChildren(this.image(figure.ownerDocument, image));
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

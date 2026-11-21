import { showToast } from '/static/toast.js';
import { createPlantUmlLanguage } from '/static/notes/plantuml-lang.js';
import { updateStats } from '/static/notes/status-bar.js';

/* --- Editor (CodeMirror is ~670 KB; loaded on first edit or when idle) -- */

let sqlLanguage = null;
let shellLanguage = null;
let plantumlLanguage = null;
let editorModules = null;
const loadEditor = () => {
  editorModules ||= Promise.all([
    import('/static/vendor/codemirror.bundle.js'),
    import('/static/components/editor.js'),
  ]).then(([codemirror, editor]) => {
    sqlLanguage = codemirror.sql().language;
    shellLanguage = codemirror.StreamLanguage.define(codemirror.shellMode);
    plantumlLanguage = createPlantUmlLanguage(codemirror.StreamLanguage);
    return { markdown: codemirror.markdown, createEditor: editor.createEditor };
  }).catch((error) => {
    editorModules = null;
    throw error;
  });
  return editorModules;
};
const fencedCodeLanguage = (info) => {
  const language = String(info || '').trim().toLowerCase();
  if (language === 'sql') return sqlLanguage;
  if (['bash', 'sh', 'shell'].includes(language)) return shellLanguage;
  if (['plantuml', 'puml'].includes(language)) return plantumlLanguage;
  return null;
};

export class CodeMirrorEditor {
  // Fetch CodeMirror once the note has been shown, so the first switch to edit mode does not wait for it.
  preloadEditorWhenIdle() {
    if (editorModules || this._editorPreloadScheduled) return;
    this._editorPreloadScheduled = true;
    const preload = () => loadEditor().catch(() => {});
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preload, { timeout: 4000 });
    else setTimeout(preload, 2000);
  }

  destroyCodeMirror() {
    this._cmInitToken = null;
    if (this.cmEditor) {
      this.cmEditor.destroy();
      this.cmEditor = null;
    }
  }

  async initCodeMirror() {
    const container = this.querySelector('#notes-cm-editor');
    if (!container) return;
    this.destroyCodeMirror();
    const initToken = (this._cmInitToken = Symbol('codemirror'));
    let modules;
    try {
      modules = await loadEditor();
    } catch (error) {
      console.error('Could not load the editor', error);
      showToast('Could not load the editor. Reload the page and try again.', 'error');
      return;
    }
    // The note may have changed or the view been redrawn while the editor downloaded.
    if (this._cmInitToken !== initToken || !container.isConnected) return;

    this.cmEditor = modules.createEditor({
      doc: this.selectedNote?.content || '',
      language: modules.markdown({ codeLanguages: fencedCodeLanguage }),
      shortcuts: [{
        key: 'Mod-s',
        run: () => {
          if (this.selectedNote && this.saveStatus === 'dirty') this.saveCurrentNote();
          return true;
        },
      }],
      placeholder: 'Start writing markdown...',
      contentAttributes: { spellcheck: 'true', lang: 'en-US', autocorrect: 'on', autocapitalize: 'sentences' },
      onUpdate: (update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        this.selectedNote.content = text;
        this.updateLivePreview(text);
        updateStats(this, this.currentContent());
        this.markDirty();
      },
      // The action bar overlays the bottom of the editor; the content's bottom padding is its height.
      scrollMargins: (view) => ({ bottom: parseFloat(getComputedStyle(view.contentDOM).paddingBottom) || 0 }),
      parent: container,
      root: document,
    });
    if (!this.selectedNote?.slug) this.cmEditor.dispatch({ selection: { anchor: 2 } }); // new note: type the title
    if (this._focusEditorWhenReady) this.focusEditor();
    this.restoreEditorView();
  }

  focusEditor() {
    if (this.cmEditor) {
      this._focusEditorWhenReady = false;
      this.cmEditor.focus();
    } else {
      this._focusEditorWhenReady = true;
    }
  }
}

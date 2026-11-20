import {
  EditorView, EditorState, basicSetup, Prec, syntaxHighlighting, classHighlighter, keymap, indentWithTab, placeholder,
} from '/static/vendor/codemirror.bundle.js';

const monokaiTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      width: '100%',
      minWidth: '0',
      backgroundColor: 'var(--color-background, #2d2a2e)',
      color: 'var(--color-text, #fcfcfa)',
      fontSize: '0.95rem',
    },
    '.cm-scroller': {
      height: '100%',
      width: '100%',
      overflow: 'auto',
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
      lineHeight: '1.7',
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--color-dimmed4, #5b595c) transparent',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '6px',
      height: '6px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      background: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'var(--color-dimmed4, #5b595c)',
      borderRadius: '3px',
    },
    '.cm-content': {
      padding: '1.25rem 1.5rem 1.25rem 1.25rem',
      caretColor: 'var(--color-accent5, #78dce8)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor': {
      borderLeft: '2px solid var(--color-accent5, #78dce8)',
    },
    '.cm-gutters': {
      display: 'none',
      padding: '1.25rem 0',
      backgroundColor: 'var(--color-dark2, #19181a)',
      color: 'var(--color-dimmed3)',
      borderRight: '1px solid var(--color-dimmed5, #403e41)',
      lineHeight: '1.7',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--color-accent5, #78dce8)',
      fontWeight: '600',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.045)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent5, #78dce8) 20%, transparent) !important',
    },
    '.cm-placeholder': {
      color: 'var(--color-dimmed4, #5b595c)',
      fontStyle: 'normal',
    },

    '.cm-lintRange-error': {
      backgroundImage: 'none !important',
      textDecoration: 'underline wavy var(--color-accent1) !important',
      textDecorationThickness: '1.5px !important',
      textUnderlineOffset: '3px !important',
    },
    '.cm-tooltip-lint': {
      backgroundColor: 'var(--color-dark2) !important',
      border: '1px solid var(--color-dimmed5) !important',
      borderRadius: '8px !important',
      padding: '0.6rem 0.8rem !important',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45) !important',
      color: 'var(--color-text) !important',
      fontFamily: 'var(--font-mono) !important',
      fontSize: '0.82rem !important',
      zIndex: '1000 !important',
    },
    '.cm-diagnostic': {
      display: 'flex !important',
      flexDirection: 'column !important',
      gap: '0.4rem !important',
      padding: '0.2rem 0 !important',
    },
    '.cm-diagnostic-error': {
      borderLeft: '3px solid var(--color-accent1) !important',
      paddingLeft: '0.6rem !important',
    },
    '.cm-diagnosticAction': {
      background: 'var(--color-dark1) !important',
      border: '1px solid var(--color-dimmed5) !important',
      borderRadius: '5px !important',
      color: 'var(--color-accent5) !important',
      padding: '0.25rem 0.6rem !important',
      fontSize: '0.76rem !important',
      fontWeight: '600 !important',
      cursor: 'pointer !important',
      transition: 'all 0.15s !important',
      marginRight: '0.35rem !important',
      marginTop: '0.25rem !important',
      display: 'inline-block !important',
    },
    '.cm-diagnosticAction:hover': {
      background: 'color-mix(in srgb, var(--color-accent5) 15%, transparent) !important',
      borderColor: 'var(--color-accent5) !important',
      color: 'var(--color-text) !important',
    },

    '.tok-keyword': {
      color: 'var(--color-accent1, #ff6188) !important',
      fontWeight: '600',
    },
    '.tok-meta': {
      color: 'var(--color-accent2, #fc9867) !important',
      fontWeight: '600',
    },
    '.tok-string': {
      color: 'var(--color-accent3, #ffd866) !important',
    },
    '.tok-comment': {
      color: 'var(--color-dimmed3, #727072) !important',
      fontStyle: 'italic',
    },
    '.tok-operator': {
      color: 'var(--color-accent5, #78dce8) !important',
      fontWeight: '600',
    },
    '.tok-typeName': {
      color: 'var(--color-accent6, #ab9df2) !important',
    },
    '.tok-atom': {
      color: 'var(--color-accent4, #a9dc76) !important',
    },
    '.tok-number': {
      color: 'var(--color-accent6, #ab9df2) !important',
    },
    '.tok-attribute': {
      color: 'var(--color-accent5, #78dce8) !important',
    },
    '.tok-tag': {
      color: 'var(--color-accent1, #ff6188) !important',
    },
    '.tok-variableName': {
      color: 'var(--color-text, #fcfcfa)',
    },
    '.tok-propertyName': { color: 'var(--color-accent2) !important' },
    '.tok-bool': { color: 'var(--color-accent4) !important' },
    '.tok-literal': { color: 'var(--color-accent6) !important' },
    '.tok-string2': { color: 'var(--color-accent3) !important' },
    '.tok-url': { color: 'var(--color-accent5) !important' },
    '.tok-labelName': { color: 'var(--color-accent2) !important' },
    '.tok-inserted': { color: 'var(--color-accent4) !important' },
    '.tok-deleted': { color: 'var(--color-accent1) !important' },
    '.tok-variableName2': { color: 'var(--color-accent2) !important' },
    '.tok-namespace': { color: 'var(--color-accent5) !important' },
    '.tok-className': { color: 'var(--color-accent6) !important' },
    '.tok-macroName': { color: 'var(--color-accent2) !important' },
    '.tok-punctuation': { color: 'var(--color-dimmed1) !important' },
    '.tok-heading': { color: 'var(--color-accent3) !important', fontWeight: '600' },
    '.tok-link': { color: 'var(--color-accent5) !important' },
    '.tok-emphasis': { fontStyle: 'italic' },
    '.tok-strong': { fontWeight: 'bold' },
    '.tok-invalid': { color: 'var(--color-accent1) !important' },
    '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--color-dark2)', color: 'var(--color-text)', border: '1px solid var(--color-dimmed5)' },
    // The suggestion list: no default glyphs, the project's accent for the chosen row, and a muted description.
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '0.85rem', maxHeight: '14rem', maxWidth: 'min(36rem, calc(100vw - 1.5rem))' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0.15rem 0.6rem', color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'color-mix(in srgb, var(--color-accent5) 25%, transparent)', color: 'var(--color-text)' },
    '.cm-completionIcon': { display: 'none' },
    '.cm-completionDetail': { color: 'var(--color-dimmed2)', fontStyle: 'normal', marginLeft: '1em' },
    '.cm-completionMatchedText': { color: 'var(--color-accent3)', textDecoration: 'none', fontWeight: '600' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent3) 25%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--color-accent2) 35%, transparent)' },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent5) 15%, transparent)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--color-dimmed5)', color: 'var(--color-accent4)' },
    '.cm-nonmatchingBracket': { color: 'var(--color-accent1)' },
    '.tok-property': { color: 'var(--color-accent2, #fc9867) !important' },
  },
  { dark: true }
);

/**
 * Create a shared Pandora editor. Call destroy() on the returned EditorView
 * when its host is removed. Language extensions and callbacks belong to callers.
 * Additional extensions are for behaviour and layout only. All editor colours
 * belong here; page themes and syntax highlighters are forbidden (enforced in tests).
 */
export function createEditor({
  parent,
  root = parent?.getRootNode(),
  doc = '',
  language = [],
  extensions = [],
  shortcuts = [],
  contentAttributes = {},
  placeholder: placeholderText = '',
  readOnly = false,
  onUpdate,
  scrollMargins,
}) {
  if (!parent) throw new Error('Editor mount element is required');
  return new EditorView({
    parent,
    root,
    doc,
    extensions: [
      basicSetup,
      language,
      Prec.highest([monokaiTheme, syntaxHighlighting(classHighlighter)]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(contentAttributes),
      keymap.of(readOnly ? [] : [indentWithTab, ...shortcuts]),
      ...(placeholderText ? [placeholder(placeholderText)] : []),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      ...(onUpdate ? [EditorView.updateListener.of(onUpdate)] : []),
      // Space covered by bars overlaying the editor, so scrolling a caret into view keeps it visible.
      ...(scrollMargins ? [EditorView.scrollMargins.of(scrollMargins)] : []),
      extensions,
    ],
  });
}

/* Math is tokenized before Markdown can consume TeX underscores or asterisks. */
(() => {
  const configured = new WeakSet();
  const inline = /^\$(?!\$|\s)((?:\\[^\n]|[^$\\\n])+?)\$(?![\d$])/;
  const block = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
  const oneLineBlock = /^ {0,3}\$\$([^\n]+?)\$\$[ \t]*(?:\n|$)/;

  function configure(marked, katex) {
    if (!marked?.use || !katex?.renderToString || configured.has(marked)) return;
    const render = (token) => katex.renderToString(token.text, {
      displayMode: token.display,
      throwOnError: false,
      errorColor: 'var(--color-red)',
      trust: false,
      maxSize: 20,
      maxExpand: 1000,
    });
    marked.use({ extensions: [
      {
        name: 'notesDisplayMath',
        level: 'block',
        start(src) { return src.match(/^ {0,3}\$\$/m)?.index; },
        tokenizer(src) {
          const match = block.exec(src) || oneLineBlock.exec(src);
          if (match) return { type: 'notesDisplayMath', raw: match[0], text: match[1], display: true };
        },
        renderer(token) { return `<div class="notes-math-display">${render(token)}</div>\n`; },
      },
      {
        name: 'notesInlineMath',
        level: 'inline',
        start(src) { return src.indexOf('$'); },
        tokenizer(src) {
          const match = inline.exec(src);
          // Whitespace inside delimiters must touch neither edge. A closing
          // dollar followed by a digit is currency (e.g. "$5 and $10").
          if (match && !/\s$/.test(match[1])) {
            return { type: 'notesInlineMath', raw: match[0], text: match[1], display: false };
          }
        },
        renderer: render,
      },
    ] });
    configured.add(marked);
  }

  globalThis.PandoraMath = { configure };
})();

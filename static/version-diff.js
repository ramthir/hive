const CONTEXT_LINES = 3;
const MAX_WORD_TOKENS = 2000;
const MIN_SHARED_RATIO = 0.5;

function linesOf(text) {
  const value = text == null ? '' : String(text);
  if (value === '') return [];
  return value.split('\n');
}

function diffSequences(before, after) {
  const beforeLength = before.length;
  const afterLength = after.length;
  const max = beforeLength + afterLength;
  const offset = max;
  let frontier = new Array(2 * max + 1);
  frontier[offset + 1] = 0;
  const frontiers = [];

  for (let depth = 0; depth <= max; depth += 1) {
    const next = frontier.slice();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth
        || (diagonal !== depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
      let beforeIndex = down
        ? frontier[offset + diagonal + 1]
        : frontier[offset + diagonal - 1] + 1;
      let afterIndex = beforeIndex - diagonal;
      while (
        beforeIndex < beforeLength
        && afterIndex < afterLength
        && before[beforeIndex] === after[afterIndex]
      ) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      next[offset + diagonal] = beforeIndex;
      if (beforeIndex >= beforeLength && afterIndex >= afterLength) {
        frontiers.push(next);
        return traceDiff(frontiers, before, after, offset);
      }
    }
    frontier = next;
    frontiers.push(next);
  }
  return [];
}

function traceDiff(frontiers, before, after, offset) {
  let beforeIndex = before.length;
  let afterIndex = after.length;
  const operations = [];

  for (let depth = frontiers.length - 1; depth >= 0; depth -= 1) {
    const diagonal = beforeIndex - afterIndex;
    let previousBefore = 0;
    let previousAfter = 0;
    if (depth > 0) {
      const previous = frontiers[depth - 1];
      const previousDiagonal = (
        diagonal === -depth
        || (diagonal !== depth && previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
      ) ? diagonal + 1 : diagonal - 1;
      previousBefore = previous[offset + previousDiagonal];
      previousAfter = previousBefore - previousDiagonal;
    }
    while (beforeIndex > previousBefore && afterIndex > previousAfter) {
      beforeIndex -= 1;
      afterIndex -= 1;
      operations.push({ type: 'equal', text: before[beforeIndex] });
    }
    if (depth === 0) break;
    if (beforeIndex === previousBefore) {
      afterIndex -= 1;
      operations.push({ type: 'add', text: after[afterIndex] });
    } else {
      beforeIndex -= 1;
      operations.push({ type: 'remove', text: before[beforeIndex] });
    }
  }

  operations.reverse();
  return operations;
}

function tokensOf(text) {
  return text.match(/\s+|\w+|[^\w\s]/gu) || [];
}

function joinTokens(tokens) {
  return tokens.join('');
}

// Changed words with only whitespace between them read as one replaced phrase,
// so they share a single mark instead of one mark per word.
function joinAcrossSpaces(segments) {
  const joined = [];
  segments.forEach((segment, index) => {
    const last = joined[joined.length - 1];
    const bridge = !segment.changed
      && !/\S/u.test(segment.text)
      && last && last.changed
      && segments[index + 1] && segments[index + 1].changed;
    if (bridge) {
      last.text += segment.text;
      return;
    }
    if (segment.changed && last && last.changed) {
      last.text += segment.text;
      return;
    }
    joined.push({ ...segment });
  });
  return joined;
}

// Marks the words that differ between a removed line and the added line it was
// edited into. Returns null when the lines are too different (or too long) for
// word marks to help, so the caller keeps the whole-line highlight only.
function wordSegments(before, after) {
  const beforeTokens = tokensOf(before);
  const afterTokens = tokensOf(after);
  if (beforeTokens.length > MAX_WORD_TOKENS || afterTokens.length > MAX_WORD_TOKENS) return null;

  let prefix = 0;
  const shortest = Math.min(beforeTokens.length, afterTokens.length);
  while (prefix < shortest && beforeTokens[prefix] === afterTokens[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix
    && beforeTokens[beforeTokens.length - 1 - suffix] === afterTokens[afterTokens.length - 1 - suffix]
  ) suffix += 1;

  const middle = diffSequences(
    beforeTokens.slice(prefix, beforeTokens.length - suffix),
    afterTokens.slice(prefix, afterTokens.length - suffix),
  );
  // Whitespace always matches, so only real tokens count towards "mostly different".
  const isWord = (token) => /\S/u.test(token);
  const sharedTokens = [
    ...beforeTokens.slice(0, prefix),
    ...beforeTokens.slice(beforeTokens.length - suffix),
    ...middle.filter((operation) => operation.type === 'equal').map((operation) => operation.text),
  ].filter(isWord).length;
  const largest = Math.max(beforeTokens.filter(isWord).length, afterTokens.filter(isWord).length);
  if (largest && sharedTokens / largest < MIN_SHARED_RATIO) return null;

  const segmentsFor = (skip) => {
    const segments = [];
    const push = (text, changed) => {
      if (!text) return;
      const last = segments[segments.length - 1];
      if (last && last.changed === changed) last.text += text;
      else segments.push({ text, changed });
    };
    push(joinTokens((skip === 'remove' ? beforeTokens : afterTokens).slice(0, prefix)), false);
    middle.forEach((operation) => {
      if (operation.type === 'equal') push(operation.text, false);
      else if (operation.type === skip) push(operation.text, true);
    });
    const tokens = skip === 'remove' ? beforeTokens : afterTokens;
    push(joinTokens(tokens.slice(tokens.length - suffix)), false);
    return joinAcrossSpaces(segments);
  };

  return { before: segmentsFor('remove'), after: segmentsFor('add') };
}

// A run of removed lines followed directly by a run of added lines is one edit:
// pair them by position and mark the words that changed inside each pair.
function markChangedWords(rows) {
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type !== 'remove') {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < rows.length && rows[index].type === 'remove') index += 1;
    const addedStart = index;
    while (index < rows.length && rows[index].type === 'add') index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      const removed = rows[removedStart + offset];
      const added = rows[addedStart + offset];
      const segments = wordSegments(removed.text, added.text);
      if (segments) {
        removed.segments = segments.before;
        added.segments = segments.after;
      }
    }
  }
  return rows;
}

function displayRows(operations) {
  const visible = operations.map(() => false);
  operations.forEach((operation, index) => {
    if (operation.type === 'equal') return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(operations.length - 1, index + CONTEXT_LINES);
    for (let cursor = start; cursor <= end; cursor += 1) visible[cursor] = true;
  });

  const rows = [];
  let hidden = 0;
  const flushHidden = () => {
    if (!hidden) return;
    rows.push({ type: 'gap', lines: hidden });
    hidden = 0;
  };
  operations.forEach((operation, index) => {
    if (!visible[index]) {
      hidden += 1;
      return;
    }
    flushHidden();
    if (operation.type === 'equal') rows.push({ type: 'context', text: operation.text });
    else rows.push({ type: operation.type, text: operation.text });
  });
  flushHidden();
  return markChangedWords(rows);
}

export function diffVersionText(versionText, otherText) {
  const operations = diffSequences(linesOf(versionText), linesOf(otherText));
  let added = 0;
  let removed = 0;
  let changes = 0;
  let inChange = false;
  operations.forEach((operation) => {
    if (operation.type === 'equal') {
      inChange = false;
      return;
    }
    if (!inChange) {
      changes += 1;
      inChange = true;
    }
    if (operation.type === 'add') added += 1;
    else removed += 1;
  });

  if (changes === 0) {
    return { matches: true, added: 0, removed: 0, changes: 0, rows: [] };
  }

  return {
    matches: false,
    added,
    removed,
    changes,
    rows: displayRows(operations),
  };
}

// Compares a saved version with the next newer snapshot, or with the saved record
// when it is the newest (`againstCurrent`). `subject` names the record ('note' or
// 'diagram') in the messages. The editor text is never an input.
export function versionStep(versionText, newerText, againstCurrent = false, subject = 'note') {
  const diff = diffVersionText(versionText, newerText);
  return { kind: diff.matches ? 'unchanged' : 'change', diff, againstCurrent: Boolean(againstCurrent), subject };
}

function unchangedSentence(step) {
  return step.againstCurrent ? `No changes from the current ${step.subject}` : 'No changes from the next version';
}

export function versionStepSummary(step) {
  if (step.kind === 'unchanged') return unchangedSentence(step);
  return versionDetailSummary(step.diff);
}

export function renderVersionStep(step, escapeHtml) {
  if (step.kind === 'unchanged') {
    return `<div class="note-version-diff-match">
      <p class="note-version-empty-title">${unchangedSentence(step)}.</p>
    </div>`;
  }
  return renderVersionDiff(step.diff, escapeHtml);
}

export function versionListLabel(diff) {
  if (diff.matches) return 'matches editor';
  return `+${diff.added} \u2212${diff.removed}`;
}

export function versionDetailSummary(diff) {
  if (diff.matches) return 'matches editor';
  const changeLabel = diff.changes === 1 ? '1 change' : `${diff.changes} changes`;
  return `+${diff.added} \u2212${diff.removed} \u00b7 ${changeLabel}`;
}

function renderLineText(row, escapeHtml) {
  if (!row.segments) return escapeHtml(row.text);
  return row.segments.map((segment) => {
    const text = escapeHtml(segment.text);
    if (!segment.changed) return text;
    return `<mark class="note-version-diff-word"><span class="note-version-diff-hidden-label">changed: </span>${text}</mark>`;
  }).join('');
}

export function renderVersionDiff(diff, escapeHtml) {
  if (diff.matches) {
    return `<div class="note-version-diff-match">
      <p class="note-version-empty-title">This version matches the editor text.</p>
    </div>`;
  }

  const rows = diff.rows.map((row) => {
    if (row.type === 'gap') return '';
    const kind = row.type === 'remove' ? 'remove' : row.type === 'add' ? 'add' : 'context';
    const label = row.type === 'remove' ? 'Removed: ' : row.type === 'add' ? 'Added: ' : '';
    const hidden = label ? `<span class="note-version-diff-hidden-label">${label}</span>` : '';
    return `<div class="note-version-diff-line is-${kind}">${hidden}${renderLineText(row, escapeHtml)}</div>`;
  }).join('');

  return `<div class="note-version-diff" aria-label="Differences from the editor text">
    <div class="note-version-diff-rows">${rows}</div>
  </div>`;
}

const VERSION_DATE_PARTS = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
const VERSION_TIME_PARTS = { hour: 'numeric', minute: '2-digit' };

// "Monday, November 2, 2026, 2:05 PM" in the reader's locale; seconds are left out.
export function formatVersionDateTime(date, locale) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString(locale, VERSION_DATE_PARTS)}, ${date.toLocaleTimeString(locale, VERSION_TIME_PARTS)}`;
}

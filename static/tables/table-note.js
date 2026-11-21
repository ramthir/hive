// [[Target]] or [[Target|label]]: Hive links notes by title or file name, not by id.
const WIKILINK_TOKEN_RE = /\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g;
const SEPARATOR_CELL_RE = /^:?-{1,}:?$/;
const PERSON_COLUMN_RE = /^(current\s+user|employee|user|associate|owner|assignee|contact|person)$/i;

/** A table note is one whose type is `table`: it opens as a table instead of rendered markdown. */
export const isTableNote = (note) => (note?.types || []).some((type) => String(type).toLowerCase() === 'table');

export function isTableRowLine(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || ''));
}

export function splitMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  const inner = trimmed.slice(1, -1);
  const cells = [];
  let current = '';
  let inWikilink = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '|' || next === '\\') {
        current += next;
        i += 1;
        continue;
      }
    }
    if (!inWikilink && ch === '[' && inner[i + 1] === '[') {
      inWikilink = true;
      current += '[[';
      i += 1;
      continue;
    }
    if (inWikilink && ch === ']' && inner[i + 1] === ']') {
      inWikilink = false;
      current += ']]';
      i += 1;
      continue;
    }
    if (ch === '|' && !inWikilink) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

export function isMarkdownSeparatorRow(line, expectedColumnCount) {
  if (!isTableRowLine(line)) return false;
  const cells = splitMarkdownTableRow(line);
  if (cells.length === 0) return false;
  if (expectedColumnCount && cells.length !== expectedColumnCount) return false;
  return cells.every((cell) => SEPARATOR_CELL_RE.test(cell));
}

export function extractWikilinkTargets(rawValue) {
  const text = String(rawValue ?? '').trim();
  if (!text) return [];
  const ids = [];
  WIKILINK_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = WIKILINK_TOKEN_RE.exec(text)) !== null) {
    ids.push(match[1].trim());
  }
  return ids;
}

export function extractWikilinkTarget(rawValue) {
  return extractWikilinkTargets(rawValue)[0] || '';
}

export function formatCellValueForEdit(rawValue) {
  const text = String(rawValue ?? '').trim();
  return text === '—' ? '' : text;
}

export function resolveCellSegments(rawValue, noteTitleMap = null) {
  const text = String(rawValue ?? '').trim();
  if (!text) return [{ type: 'text', text: '—' }];
  const segments = [];
  WIKILINK_TOKEN_RE.lastIndex = 0;
  let lastIndex = 0;
  let match;
  while ((match = WIKILINK_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const target = match[1].trim();
    const explicitLabel = match[2]?.trim();
    const resolvedTitle = noteTitleMap instanceof Map ? noteTitleMap.get(target) : noteTitleMap?.[target];
    const label = explicitLabel || resolvedTitle || target;
    segments.push({ type: 'wikilink', target, label });
    lastIndex = match.index + match[0].length;
  }
  if (segments.length === 0) return [{ type: 'text', text }];
  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return segments;
}

export function resolveCellDisplay(rawValue, noteTitleMap = null) {
  const segments = resolveCellSegments(rawValue, noteTitleMap);
  const firstLink = segments.find((seg) => seg.type === 'wikilink');
  return {
    isWikilink: Boolean(firstLink),
    target: firstLink ? firstLink.target : null,
    label: segments.map((seg) => (seg.type === 'wikilink' ? seg.label : seg.text)).join(''),
  };
}

export function parseMarkdownTableNote(content) {
  const rawContent = String(content ?? '');
  const lines = rawContent.split(/\r?\n/);
  let title = 'Untitled Table';
  for (const line of lines) {
    const headingMatch = /^\s*#\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      title = headingMatch[1];
      break;
    }
  }

  let headerIndex = -1;
  let headerCells = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!isTableRowLine(lines[i])) continue;
    const candidateHeaders = splitMarkdownTableRow(lines[i]);
    if (candidateHeaders.length > 0 && isMarkdownSeparatorRow(lines[i + 1], candidateHeaders.length)) {
      headerIndex = i;
      headerCells = candidateHeaders;
      break;
    }
  }

  if (headerIndex === -1) {
    const description = lines
      .filter((line) => line.trim() && !/^\s*#+\s*/.test(line))
      .map((line) => line.trim())
      .join(' ');
    return {
      rawContent,
      title,
      description,
      prefixLines: lines,
      headerLine: '',
      separatorLine: '',
      suffixLines: [],
      columns: [],
      rows: [],
    };
  }

  const separatorIndex = headerIndex + 1;
  let endIndex = separatorIndex + 1;
  while (endIndex < lines.length && isTableRowLine(lines[endIndex])) {
    endIndex += 1;
  }

  const prefixLines = lines.slice(0, headerIndex);
  const headerLine = lines[headerIndex];
  const separatorLine = lines[separatorIndex];
  const dataLines = lines.slice(separatorIndex + 1, endIndex);
  const suffixLines = lines.slice(endIndex);

  const description = prefixLines
    .filter((line) => line.trim() && !/^\s*#+\s*/.test(line))
    .map((line) => line.trim())
    .join(' ');

  const rows = dataLines.map((line, rowIndex) => {
    const cells = splitMarkdownTableRow(line);
    const row = { id: rowIndex, _rowIndex: rowIndex };
    headerCells.forEach((_label, colIndex) => {
      row[`col_${colIndex}`] = cells[colIndex] ?? '';
    });
    return row;
  });

  const usesEmDash = rows.some((row) =>
    headerCells.some((_label, colIndex) => row[`col_${colIndex}`] === '—')
  );
  const emptyToken = usesEmDash ? '—' : '';

  const columns = headerCells.map((label, index) => {
    const key = `col_${index}`;
    const hasWikilinkCell = rows.some((row) => extractWikilinkTargets(row[key]).length > 0);
    const isContactColumn = PERSON_COLUMN_RE.test(label.trim());
    return {
      key,
      index,
      label,
      isWikilink: hasWikilinkCell || isContactColumn,
      targetType: isContactColumn ? 'contact' : null,
      emptyToken,
    };
  });

  return {
    rawContent,
    title,
    description,
    prefixLines,
    headerLine,
    separatorLine,
    suffixLines,
    columns,
    rows,
  };
}

function escapeCellForMarkdown(value, emptyToken) {
  const text = String(value ?? '').trim();
  if (!text) return emptyToken || '';
  let result = '';
  let inWikilink = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inWikilink && ch === '[' && text[i + 1] === '[') {
      inWikilink = true;
      result += '[[';
      i += 1;
      continue;
    }
    if (inWikilink && ch === ']' && text[i + 1] === ']') {
      inWikilink = false;
      result += ']]';
      i += 1;
      continue;
    }
    if (ch === '|' && !inWikilink) {
      result += '\\|';
      continue;
    }
    result += ch;
  }
  return result;
}

export function serializeMarkdownTableNote(parsed, rows) {
  if (!parsed?.columns?.length) return parsed?.rawContent ?? '';
  const dataLines = (rows || []).map((row) => {
    const cells = parsed.columns.map((col) => escapeCellForMarkdown(row?.[col.key], col.emptyToken));
    return `| ${cells.join(' | ')} |`;
  });
  return [
    ...parsed.prefixLines,
    parsed.headerLine,
    parsed.separatorLine,
    ...dataLines,
    ...parsed.suffixLines,
  ].join('\n');
}

export function filterTableRows(rows, columns, query, noteTitleMap = null) {
  const cleanQuery = String(query ?? '').trim().toLowerCase();
  if (!cleanQuery) return rows || [];
  return (rows || []).filter((row) =>
    (columns || []).some((col) => {
      const raw = String(row?.[col.key] ?? '');
      if (raw.toLowerCase().includes(cleanQuery)) return true;
      const display = resolveCellDisplay(raw, noteTitleMap).label;
      return display.toLowerCase().includes(cleanQuery);
    })
  );
}

export function sortTableRows(rows, sortKey, sortDir = 'asc', noteTitleMap = null) {
  const list = [...(rows || [])];
  if (!sortKey) return list;
  const direction = sortDir === 'desc' ? -1 : 1;
  return list.sort((a, b) => {
    const labelA = resolveCellDisplay(a?.[sortKey], noteTitleMap).label;
    const labelB = resolveCellDisplay(b?.[sortKey], noteTitleMap).label;
    const emptyA = !labelA || labelA === '—';
    const emptyB = !labelB || labelB === '—';
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    return direction * labelA.localeCompare(labelB, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const STAT_COLOR_TOKENS = new Set(['blue', 'green', 'purple', 'orange', 'yellow', 'red']);

export function parseTableConfig(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  let inBlock = false;
  let buffer = [];
  for (const line of lines) {
    if (!inBlock) {
      if (/^ {0,3}```json(?:\s+(?:table-config|table-stats))?\s*$/i.test(line)) {
        inBlock = true;
        buffer = [];
      }
      continue;
    }
    if (/^ {0,3}```\s*$/.test(line)) {
      try {
        const parsed = JSON.parse(buffer.join('\n'));
        if (Array.isArray(parsed)) {
          return {
            stats: parsed.filter((item) => item && typeof item.label === 'string').slice(0, 5),
          };
        }
        if (parsed && typeof parsed === 'object') {
          const rawStats = Array.isArray(parsed.stats) ? parsed.stats : [];
          return {
            ...parsed,
            stats: rawStats.filter((item) => item && typeof item.label === 'string').slice(0, 5),
          };
        }
      } catch (_err) {
        /* Ignore malformed JSON blocks and continue scanning. */
      }
      inBlock = false;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  return { stats: [] };
}

export function parseTableStatsConfig(content) {
  return parseTableConfig(content).stats;
}

function resolveStatColor(color) {
  const clean = String(color ?? '').trim().toLowerCase();
  if (STAT_COLOR_TOKENS.has(clean)) return `var(--color-${clean})`;
  if (/^var\(--color-[a-z0-9-]+\)$/.test(clean)) return clean;
  return '';
}

export function evaluateTableStats(statsConfig, parsed) {
  const rows = parsed?.rows || [];
  const columns = parsed?.columns || [];
  const findColKey = (name) => {
    const target = String(name ?? '').trim().toLowerCase();
    return columns.find((c) => c.label.trim().toLowerCase() === target)?.key || null;
  };
  const isEmpty = (val) => {
    const text = String(val ?? '').trim();
    return !text || text === '—';
  };

  return (statsConfig || []).map((card) => {
    const op = String(card.op || 'count').trim().toLowerCase();
    const colKey = card.column ? findColKey(card.column) : null;
    let count = 0;

    if (op === 'count') {
      count = rows.length;
    } else if (colKey) {
      if (op === 'distinct') {
        const seen = new Set();
        for (const row of rows) {
          const val = String(row?.[colKey] ?? '').trim();
          if (!isEmpty(val)) seen.add(val);
        }
        count = seen.size;
      } else if (op === 'count_where') {
        if (card.equals !== undefined) {
          const expected = String(card.equals).trim().toLowerCase();
          count = rows.filter((r) => String(r?.[colKey] ?? '').trim().toLowerCase() === expected).length;
        } else if (card.contains !== undefined) {
          const needle = String(card.contains).trim().toLowerCase();
          count = rows.filter((r) => String(r?.[colKey] ?? '').toLowerCase().includes(needle)).length;
        }
      } else if (op === 'count_empty') {
        count = rows.filter((r) => isEmpty(r?.[colKey])).length;
      } else if (op === 'count_nonempty') {
        count = rows.filter((r) => !isEmpty(r?.[colKey])).length;
      }
    }

    return {
      label: card.label,
      value: count.toLocaleString(),
      sub: typeof card.sub === 'string' ? card.sub : '',
      icon:
        typeof card.icon === 'string' &&
        /^(?:(?:fa-solid|fa-regular|fa-brands|fa-light|fa-thin|fa-duotone|fas|far|fab)\s+)?fa-[a-z0-9-]+$/i.test(
          card.icon.trim()
        )
          ? card.icon.trim()
          : 'fa-chart-simple',
      color: resolveStatColor(card.color),
    };
  });
}

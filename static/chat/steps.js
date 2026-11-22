/* What a finished chat turn shows about its work, without DOM: a readable label for each shell command and the one-line summary. */

const FLAGS_WITH_VALUE = new Set(['--glob', '-g', '-t', '--type', '-A', '-B', '-C', '-m', '--max-count', '-e', '--regexp', '-f', '--file', '-j', '--threads', '--max-depth']);

/** The words of one shell command, honouring single and double quotes (no expansion: this is only for naming a step). */
export function words(command) {
  const out = [];
  let word = '';
  let quote = '';
  let started = false;
  for (const char of String(command ?? '')) {
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === ';' || char === '|' || char === '&') {
      if (started || word) out.push(word);
      word = ''; started = false;
      out.push(char);
    }
    else if (/\s/.test(char)) {
      if (started || word) out.push(word);
      word = ''; started = false;
    } else { word += char; started = true; }
  }
  if (started || word) out.push(word);
  return out;
}

/** The command split into the commands joined by `&&`, `;` and `|`, each as its words. */
function segments(command) {
  const list = [[]];
  for (const word of words(command)) {
    if (['&', ';', '|'].includes(word)) list.push([]);
    else list[list.length - 1].push(word);
  }
  return list.map((s) => (['then', 'do', 'else', 'elif'].includes(s[0]) ? s.slice(1) : s)).filter((s) => s.length);
}

const positional = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { out.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg.length > 1) { if (FLAGS_WITH_VALUE.has(arg)) i += 1; continue; }
    out.push(arg);
  }
  return out;
};

const quoted = (text) => `“${text}”`;
const files = (list) => (list.length > 1 ? `${list[0]} and ${list.length - 1} more` : list[0]);
const pattern = (text) => text.replace(/\\b/g, '').replace(/\\\\/g, '\\').trim();

/** A readable name for one command, or '' when it is not one we recognise. */
function nameOf(argv) {
  const [program, ...args] = argv;
  const sub = args.find((a) => !a.startsWith('-'));
  const rest = positional(args);
  switch (program) {
    case 'rg': case 'grep': {
      if (args.includes('--files')) return 'Listed notes';
      return rest.length ? `Searched notes for ${quoted(pattern(rest[0]))}` : '';
    }
    case 'cat': case 'bat': case 'head': case 'tail': case 'less':
      return rest.length ? `Read ${files(rest)}` : '';
    case 'sed': {
      if (args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')) return rest.length > 1 ? `Edited ${rest[rest.length - 1]}` : 'Edited a note';
      return args.includes('-n') && rest.length > 1 ? `Read ${rest[rest.length - 1]}` : '';
    }
    case 'ls': case 'fd': case 'find': case 'tree': return 'Listed files';
    case 'mv': return rest.length > 1 ? `Moved ${rest[0]} to ${rest[1]}` : '';
    case 'rm': return rest.length ? `Removed ${files(rest)}` : '';
    case 'git': {
      const gitRest = positional(args.slice(args.indexOf(sub) + 1));
      switch (sub) {
        case 'commit': {
          const at = args.findIndex((a) => a === '-m' || a === '--message');
          return at >= 0 && args[at + 1] ? `Committed: ${args[at + 1].split('\n')[0]}` : 'Committed';
        }
        case 'add': return 'Staged changes';
        case 'status': return 'Checked what changed';
        case 'diff': return 'Compared changes';
        case 'log': case 'show': return 'Read the history';
        case 'mv': return gitRest.length > 1 ? `Renamed ${gitRest[0]} to ${gitRest[1]}` : 'Renamed a note';
        default: return '';
      }
    }
    default: return '';
  }
}

/** The label a step shows: "Searched notes for “wifi”", "Read home-network.md", "Committed: doc: …". Compound commands
 *  take the most telling part (a commit, then an edit, then the first one we know); anything unknown keeps the command itself. */
export function friendlyLabel(step) {
  if (step?.tool === 'file_change') return String(step.label || '').replace(/^Editing /, 'Edited ');
  const names = segments(step?.label).map(nameOf).filter(Boolean);
  const best = names.find((n) => n.startsWith('Committed')) || names.find((n) => /^(Edited|Moved|Removed|Renamed)/.test(n)) || names[0];
  return best || String(step?.label || '');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Worked for 14s · 9 steps · changed 1 note" for a finished turn; null while it runs or when it did nothing. */
export function workSummary(turn) {
  const steps = turn?.steps || [];
  if (!turn || turn.status === 'running' || !(steps.length || turn.narration?.length)) return null;
  const seconds = turn.startedAt && turn.endedAt ? Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000)) : null;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const wrote = steps.some((s) => s.write && s.status !== 'failed');
  const changed = (turn.changed || []).length;
  const parts = [seconds === null ? 'Worked' : `Worked for ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}`];
  if (steps.length) parts.push(plural(steps.length, 'step'));
  if (changed) parts.push(`changed ${plural(changed, 'note')}`);
  else if (wrote) parts.push('edited files');
  if (failed) parts.push(`${failed} failed`);
  return { text: parts.join(' · '), wrote: wrote || changed > 0, failed, open: failed > 0 || turn.status === 'error' };
}

/** How many of the newest steps show while Codex is still working; the rest fold into "+N earlier". */
export const LIVE_STEPS = 4;

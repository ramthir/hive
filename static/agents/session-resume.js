/** Build only commands with a safe positional session ID; callers may separately offer raw-ID copying. */
export function sessionResumeCommand(cli, session) {
  if (typeof cli !== 'string' || typeof session !== 'string' || !session) return null;
  const provider = cli.toLowerCase();
  const prefixes = {
    claude: 'claude --resume', 'claude-code': 'claude --resume',
    codex: 'codex resume', agy: 'agy --conversation', antigravity: 'agy --conversation',
    copilot: 'copilot --resume', grok: 'grok --resume',
  };
  const prefix = Object.hasOwn(prefixes, provider) ? prefixes[provider] : null;
  let identity = session;
  if (provider === 'codex') {
    const rollout = session.match(/^(?:\d{4}\/\d{2}\/\d{2}\/)?rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
    if (rollout) identity = rollout[1];
  }
  return prefix && /^\w[\w-]*$/.test(identity) ? `${prefix} ${identity}` : null;
}

/** Delegated handler survives table redraws and reports clipboard failure without claiming success. */
export async function copySessionResume(event, copy, notify) {
  const button = event.target?.closest?.('[data-session-resume]');
  const command = button?.getAttribute('data-session-resume');
  if (!command) return;
  event.stopPropagation();
  try {
    await copy(command);
    notify('Resume command copied to clipboard', 'success');
  } catch {
    notify('Could not copy resume command', 'error');
  }
}

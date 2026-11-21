"""Writes commit messages by running Codex once, the way Pandora's workflow agent step does: `codex exec` in a read-only
sandbox, no saved session, no user config or rules, the prompt on standard input and the answer read from `-o <file>`.
The note's diff is sent to the model (so this is opt-in: see HIVE_COMMIT_MESSAGES)."""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger("hive.commit_messages")

MAX_DIFF_CHARS = 12_000
MAX_SUBJECT = 72

PROMPT = """You write git commit subjects for a vault of markdown notes.

Write ONE subject line for the change below, to the note "{title}".
- Format: `doc: <what changed>`, lower case after the prefix, imperative mood, at most 60 characters, no full stop.
- Say what the change is about (for example `doc: add storage options to Home network`), not that the note was edited.
- Ignore the `updated:` date in the front matter and whitespace or table-padding changes.
- Reply with the subject line only: no quotes, no explanation, no body.

The commit currently reads: {subject}

Diff:
{diff}
"""


def codex_program(configured: str | None = None) -> str | None:
    """The absolute path of the Codex program (HIVE_CODEX, else the one on PATH), or None."""
    program = configured or shutil.which("codex")
    return program if program and os.path.isabs(program) and os.access(program, os.X_OK) else None


def clean_subject(text: str) -> str | None:
    """The first line of the answer as a commit subject, or None when it is not usable."""
    line = next((l.strip() for l in (text or "").splitlines() if l.strip()), "")
    line = line.strip("`\"' ").rstrip(".")
    if not line:
        return None
    if not re.match(r"^[a-z]+(\([^)]*\))?!?: \S", line):
        line = f"doc: {line}"
    return line if len(line) <= MAX_SUBJECT else None


class CodexCommitMessages:
    def __init__(self, program: str, model: str | None = None, timeout: float = 90, effort: str | None = None):
        self.program, self.model, self.timeout, self.effort = program, model, timeout, effort

    def describe(self, title: str, subject: str, diff: str) -> str | None:
        """A better subject for the commit, or None (Codex missing, failed, timed out or answered badly)."""
        if not diff.strip():
            return None
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + "\n[diff cut]"
        prompt = PROMPT.format(title=title, subject=subject, diff=diff)
        env = {"PATH": f"{os.path.dirname(self.program)}:/usr/local/bin:/usr/bin:/bin", "HOME": os.path.expanduser("~"), "LANG": "C.UTF-8"}
        env.update({name: os.environ[name] for name in ("CODEX_HOME", "OPENAI_API_KEY") if name in os.environ})
        scratch = tempfile.mkdtemp(prefix="hive-codex-")  # Codex runs here, never in the notes
        try:
            answer = Path(scratch) / "answer.txt"
            args = [self.program, "exec", "--sandbox", "read-only", "--skip-git-repo-check",
                    "--ignore-user-config", "--ignore-rules", "-C", scratch, "-o", str(answer),
                    *(["--model", self.model] if self.model else []),
                    *(["-c", f'model_reasoning_effort="{self.effort}"'] if self.effort else []), "-"]
            result = subprocess.run(args, input=prompt.encode(), capture_output=True, env=env, timeout=self.timeout, cwd=scratch)
            if result.returncode != 0:
                log.warning("codex failed (%s): %s", result.returncode, result.stderr.decode("utf-8", "replace")[-300:].strip())
                return None
            return clean_subject(answer.read_text(encoding="utf-8", errors="replace")) if answer.is_file() else None
        except (OSError, subprocess.TimeoutExpired) as error:
            log.warning("codex could not run: %s", error)
            return None
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

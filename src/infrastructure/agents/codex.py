"""Writes commit messages with Codex: `codex exec` with no shell and no user config or rules, the prompt on standard input and
the answer read from `-o <file>`. With a `SessionStore` (what Hive uses) it works in the notes folder and carries on in one saved
Codex session per month, `codex exec resume <id>`, so it knows the month's earlier commits; without one every call is a fresh `--ephemeral` run.
The note's diff is sent to the model (so this is opt-in: see HIVE_COMMIT_MESSAGES)."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from datetime import date
from pathlib import Path

from src.infrastructure.agents.sessions import SessionStore

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


def thread_id(stdout: bytes) -> str | None:
    """The session id of a `codex exec --json` run (its `thread.started` line)."""
    for raw in stdout.decode("utf-8", "replace").splitlines():
        try:
            event = json.loads(raw)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "thread.started" and event.get("thread_id"):
            return str(event["thread_id"])
    return None


class CodexCommitMessages:
    SESSION = "commit"

    def __init__(self, program: str, model: str | None = None, timeout: float = 90, effort: str | None = None,
                 notes_dir: Path | None = None, sessions: SessionStore | None = None, today: Callable[[], date] = date.today):
        self.program, self.model, self.timeout, self.effort = program, model, timeout, effort
        self.notes_dir, self.sessions, self.today = (Path(notes_dir) if notes_dir else None), sessions, today

    def _args(self, cwd: str, answer: Path, session: str | None) -> list[str]:
        common = ["--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--disable", "shell_tool", "--disable", "unified_exec", "-o", str(answer),
                  *(["--model", self.model] if self.model else []),
                  *(["-c", f'model_reasoning_effort="{self.effort}"'] if self.effort else [])]
        if not self.sessions:
            return [self.program, "exec", "--sandbox", "read-only", "--ephemeral", "-C", cwd, *common, "-"]
        # `exec resume` has no --sandbox or -C: the sandbox goes through -c and the folder is the process's own
        if session:
            return [self.program, "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', *common, session, "-"]
        return [self.program, "exec", "--json", "--sandbox", "read-only", "-C", cwd, *common, "-"]

    def describe(self, title: str, subject: str, diff: str) -> str | None:
        """A better subject for the commit, or None (Codex missing, failed, timed out or answered badly)."""
        if not diff.strip():
            return None
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + "\n[diff cut]"
        prompt = PROMPT.format(title=title, subject=subject, diff=diff)
        env = {"PATH": f"{os.path.dirname(self.program)}:/usr/local/bin:/usr/bin:/bin", "HOME": os.path.expanduser("~"), "LANG": "C.UTF-8"}
        env.update({name: os.environ[name] for name in ("CODEX_HOME", "OPENAI_API_KEY") if name in os.environ})
        scratch = tempfile.mkdtemp(prefix="hive-codex-")  # the answer file lives here
        cwd = str(self.notes_dir) if self.sessions and self.notes_dir else scratch
        try:
            answer = Path(scratch) / "answer.txt"
            month = f"{self.today():%Y-%m}"
            session = self.sessions.get(self.SESSION) if self.sessions else None
            if session and self.sessions.tag(self.SESSION) != month:
                session = None  # a new session every month: it would otherwise grow for ever
            for attempt in (0, 1):
                answer.unlink(missing_ok=True)
                result = subprocess.run(self._args(cwd, answer, session), input=prompt.encode(), capture_output=True, env=env, timeout=self.timeout, cwd=cwd)
                if result.returncode == 0:
                    break
                log.warning("codex failed (%s): %s", result.returncode, result.stderr.decode("utf-8", "replace")[-300:].strip())
                if not (session and attempt == 0):
                    return None
                session = None  # the saved session cannot be resumed (its file is gone): start a new one
                self.sessions.clear(self.SESSION)
            if self.sessions and (new := thread_id(result.stdout)):
                self.sessions.set(self.SESSION, new, month)
            return clean_subject(answer.read_text(encoding="utf-8", errors="replace")) if answer.is_file() else None
        except (OSError, subprocess.TimeoutExpired) as error:
            log.warning("codex could not run: %s", error)
            return None
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

"""Claude Code (`claude`) as the agent behind the chat and the commit messages, the way `codex.py` and `agy.py` do it.

`claude -p --output-format stream-json --verbose` streams one JSON message per line (`system` init with the session id, `assistant`
messages with text and tool calls, `user` messages with the tool results, a final `result`); `--resume <id>` continues a
session. The prompt goes in on standard input, so its length does not matter."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from src.domain.chat import ClaudeEvents
from src.infrastructure.agents.codex import CodexCommitMessages, clean_subject
from src.infrastructure.agents.codex_chat import CodexChat


def claude_program(configured: str | None = None) -> str | None:
    """The absolute path of `claude`: HIVE_CLAUDE, else CLAUDE_BIN, else the one on PATH, else ~/.local/bin/claude, or None."""
    for program in (configured, os.environ.get("CLAUDE_BIN"), shutil.which("claude"), os.path.expanduser("~/.local/bin/claude")):
        if program and os.path.isabs(program) and os.access(program, os.X_OK):
            return program
    return None


ENV_NAMES = ("CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "XDG_CONFIG_HOME")


class ClaudeChat(CodexChat):
    """The chat through `claude`: it works in the notes folder with its own tools (Bash, Read, Edit...) and no permission prompts
    (there is no one to answer them; like Codex here it runs unsandboxed, so the port must only be reachable from this machine)."""
    name = "Claude"
    session_key = "chat-claude"
    missing = "Claude was not found. Install it or set HIVE_CLAUDE."
    env_names = ENV_NAMES

    def command(self, prompt: str, session: str | None) -> tuple[list[str], bytes | None]:
        args = [self.program, "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
                *(["--model", self.model] if self.model else []), *(["--effort", self.effort] if self.effort else []),
                *(["--resume", session] if session else [])]
        return args, prompt.encode()

    def events(self):
        return ClaudeEvents().feed


class ClaudeCommitMessages(CodexCommitMessages):
    """Commit messages through `claude`: no tools at all (it only answers), in the notes folder, one session per month."""
    SESSION = "commit-claude"
    env_names = ENV_NAMES

    def _args(self, cwd: str, answer: Path, session: str | None, prompt: str = "") -> list[str]:
        return [self.program, "-p", "--output-format", "json", "--tools", "",
                *(["--model", self.model] if self.model else []), *(["--effort", self.effort] if self.effort else []),
                *(["--resume", session] if session else [])]

    def _result(self, stdout: bytes) -> dict | None:
        try:
            data = json.loads(stdout.decode("utf-8", "replace"))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _session_of(self, stdout: bytes) -> str | None:
        data = self._result(stdout)
        return str(data["session_id"]) if data and data.get("session_id") else None

    def _answer_of(self, stdout: bytes, answer: Path) -> str | None:
        data = self._result(stdout)
        return clean_subject(str(data.get("result") or "")) if data and not data.get("is_error") else None

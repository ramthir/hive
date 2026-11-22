"""Antigravity (`agy`) as the agent behind the chat and the commit messages, the way `codex.py` and `codex_chat.py` do it with Codex.

`agy --print=<prompt> --output-format stream-json` streams one JSON event per line (`init` with the conversation id, `step_update`
for each tool call and reply, a final `result`); `--conversation <id>` resumes a conversation. The prompt is an argument, not
standard input, so a very long one is cut in the middle to stay under the operating system's limit."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from src.domain.chat import AgyEvents
from src.infrastructure.agents.codex import CodexCommitMessages, clean_subject
from src.infrastructure.agents.codex_chat import CodexChat

MAX_PROMPT_CHARS = 100_000  # one argument may not pass ~128 KB


def agy_program(configured: str | None = None) -> str | None:
    """The absolute path of `agy`: HIVE_AGY, else AGY_BIN, else the one on PATH, else ~/.local/bin/agy, or None."""
    for program in (configured, os.environ.get("AGY_BIN"), shutil.which("agy"), os.path.expanduser("~/.local/bin/agy")):
        if program and os.path.isabs(program) and os.access(program, os.X_OK):
            return program
    return None


def fit(prompt: str) -> str:
    if len(prompt) <= MAX_PROMPT_CHARS:
        return prompt
    half = MAX_PROMPT_CHARS // 2
    return prompt[:half] + "\n[…cut…]\n" + prompt[-half:]


class AgyChat(CodexChat):
    """The chat through `agy`: it works in the notes folder with its own tools and shell, and no permission prompts (there is no
    one to answer them; like Codex here it runs unsandboxed, so the port must only be reachable from this machine)."""
    name = "Antigravity"
    session_key = "chat-agy"
    missing = "Antigravity (agy) was not found. Install it or set HIVE_AGY."
    env_names = ("AGY_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XDG_CONFIG_HOME", "XDG_DATA_HOME")

    def command(self, prompt: str, session: str | None) -> tuple[list[str], bytes | None]:
        args = [self.program, f"--print={fit(prompt)}", "--output-format", "stream-json", "--dangerously-skip-permissions",
                *(["--model", self.model] if self.model else []), *(["--effort", self.effort] if self.effort else []),
                *(["--conversation", session] if session else [])]
        return args, None

    def events(self):
        return AgyEvents().feed


class AgyCommitMessages(CodexCommitMessages):
    """Commit messages through `agy`: plan mode (it answers, it does not edit), in the notes folder, one conversation per month."""
    SESSION = "commit-agy"
    env_names = AgyChat.env_names

    def _args(self, cwd: str, answer: Path, session: str | None, prompt: str = "") -> list[str]:
        return [self.program, f"--print={fit(prompt)}", "--output-format", "json", "--mode", "plan",
                *(["--model", self.model] if self.model else []), *(["--effort", self.effort] if self.effort else []),
                *(["--conversation", session] if session else [])]

    def _stdin(self, prompt: str) -> bytes:
        return b""

    def _session_of(self, stdout: bytes) -> str | None:
        try:
            data = json.loads(stdout.decode("utf-8", "replace"))
        except ValueError:
            return None
        return str(data["conversation_id"]) if isinstance(data, dict) and data.get("conversation_id") else None

    def _answer_of(self, stdout: bytes, answer: Path) -> str | None:
        try:
            data = json.loads(stdout.decode("utf-8", "replace"))
        except ValueError:
            return None
        ok = isinstance(data, dict) and data.get("status") == "SUCCESS"
        return clean_subject(str(data.get("response") or "")) if ok else None

"""Chat over the notes: builds Codex's prompt, runs it and reports which notes the answer changed."""
from __future__ import annotations

import logging
from datetime import date
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol

from src.application.notes.service import NoteService
from src.infrastructure.git.client import GitClient

log = logging.getLogger("hive.chat")

MAX_TURNS = 12  # earlier turns are dropped: the page keeps no history and Codex keeps none either
MAX_MESSAGE_CHARS = 8_000
MAX_INSTRUCTION_CHARS = 20_000
INSTRUCTION_FILES = ("AGENTS.md", "agents.md", "AGENT.md", "agent.md")

SYSTEM = """You are the assistant of a personal notes vault (markdown notes, one per file, linked with [[wiki links]]).
You can only use the notes tools you were given: search_notes, read_note, list_notes, backlinks, create_note, edit_note,
append_to_note, rewrite_note, set_note_properties, list_time, log_time, remove_time. You have no shell, no internet and no other files.

Rules:
- Answer from the notes. Search and read before answering anything about the user's own information, and cite the notes you used
  as [[Note title]]. If the notes do not say, answer that they do not; never invent personal facts.
- Change notes only when the user asks you to (add, update, move to done, tidy, create). Make the smallest edit that does it
  (edit_note or append_to_note rather than rewrite_note), keep the existing style, and never delete content that was not asked for.
- A note's title is its first `# heading` and its file name follows from it: do not change a heading unless asked to rename the note.
- Time is logged only on notes of type task or meeting, in the `time` of the note (minutes per day). To log time use log_time (it adds to the day unless asked to set it); read it back with list_time or read_note. Work out dates such as "yesterday" or "last week" from today's date.
- After a change, say in one line which note you changed and what you did.
- Be concise. Use markdown."""


class Runner(Protocol):
    def run(self, prompt: str) -> Iterator[dict]: ...


def instructions(root: Path) -> str:
    """The vault's own instructions for agents (AGENTS.md or agent.md in the notes folder), cut to a sane size."""
    for name in INSTRUCTION_FILES:
        path = root / name
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                continue
            return text[:MAX_INSTRUCTION_CHARS] + ("\n[instructions cut]" if len(text) > MAX_INSTRUCTION_CHARS else "")
    return ""


def build_prompt(messages: list[dict], vault_instructions: str = "", today: date | None = None) -> str:
    """System rules, the vault's instructions and the last turns; the final message is the question to answer."""
    turns = [{"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("content") or "")[:MAX_MESSAGE_CHARS]}
             for m in messages if str(m.get("content") or "").strip()][-MAX_TURNS:]
    parts = [SYSTEM + (f"\n\nToday is {today:%A} {today.isoformat()}." if today else "")]
    if vault_instructions:
        parts.append(f"Instructions written by the owner of this vault (they apply to every task):\n<vault_instructions>\n{vault_instructions}\n</vault_instructions>")
    if len(turns) > 1:
        parts.append("Conversation so far:\n" + "\n\n".join(f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['content']}" for t in turns[:-1]))
    parts.append(f"Question from the user (answer this one):\n{turns[-1]['content']}")
    return "\n\n".join(parts)


class ChatService:
    def __init__(self, runner: Runner | None, notes: NoteService, git: GitClient, root: Path):
        self.runner, self.notes, self.git, self.root = runner, notes, git, Path(root)

    @property
    def available(self) -> bool:
        return self.runner is not None

    def _head(self) -> str | None:
        proc = self.git.run("rev-parse", "--verify", "-q", "HEAD", check=False)
        return proc.stdout.strip() or None if proc.returncode == 0 else None

    def _changed(self, before: str | None, after: str | None) -> list[dict]:
        """Notes the commits between the two heads touched and that still exist, as {slug, title}."""
        if after is None or before == after:
            return []
        args = ["diff", "--name-only", "--no-renames", before, after] if before else ["show", "--name-only", "--format=", after]
        names = [n for n in self.git.run(*args, check=False).stdout.splitlines() if n.endswith(".md") and "/" not in n]
        out = []
        for slug in dict.fromkeys(n[:-3] for n in names):
            try:
                out.append({"slug": slug, "title": self.notes.get(slug).title})
            except Exception:  # deleted or renamed away in a later commit
                continue
        return out

    def stream(self, messages: list[dict]) -> Iterator[dict]:
        """Codex's events for the question (the last message), then `changed` (notes it saved) when it ends."""
        if self.runner is None:
            yield {"type": "error", "message": "Codex is not available (set HIVE_CODEX or put codex on PATH)."}
            return
        if not messages or messages[-1].get("role") != "user" or not str(messages[-1].get("content") or "").strip():
            yield {"type": "error", "message": "Ask a question first."}
            return
        before = self._head()
        changed: list[dict] = []
        try:
            yield from self.runner.run(build_prompt(messages, instructions(self.root), self.notes.today()))
        finally:
            self.notes.invalidate()  # the tools saved from another process: re-read what changed on the next request
            try:
                changed = self._changed(before, self._head())
            except Exception:
                log.exception("could not list the notes a chat changed")
        if changed:
            yield {"type": "changed", "notes": changed}

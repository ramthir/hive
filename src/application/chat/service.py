"""Chat over the notes: builds Codex's prompt, runs it and reports which notes the answer changed."""
from __future__ import annotations

import logging
from datetime import date
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol

from src.application.notes.service import NoteService
from src.infrastructure.agents.sessions import SessionStore
from src.infrastructure.git.client import GitClient

log = logging.getLogger("hive.chat")

MAX_TURNS = 12  # a chat without a Codex session to resume replays this many turns; earlier ones are dropped
MAX_MESSAGE_CHARS = 8_000

SYSTEM = """You are the assistant of a personal notes vault: your current folder, with markdown notes (one per file, linked with [[wiki links]]).
Work in it directly with shell commands (rg, cat, sed, git). Read AGENTS.md in this folder first if there is one and follow it. Stay inside this folder.

Rules:
- Answer from the notes. Search and read before answering anything about the user's own information, and cite the notes you used
  as [[Note title]]. If the notes do not say, answer that they do not; never invent personal facts.
- Change notes only when the user asks you to. Make the smallest edit that does it, keep the existing style and front matter, and never delete content or notes that were not asked for.
- A note's title is its first `# heading` and its file name is the kebab-case of it: if you rename a note, `git mv` the file and update the `[[links]]` that point to it.
- Time is logged only on notes of type task or meeting, in the `time:` front matter key (minutes per ISO day, e.g. `time: {2026-11-20: 90}`). Work out dates such as "yesterday" from today's date.
- After changing notes, commit only the files you changed, in this session: `git add -- <files> && git commit -m "doc: <what changed>" -- <files>`. The owner may have other uncommitted
  work here: never stage it, and never reset, stash, checkout, clean or discard anything. Never push.
- After a change, say in one line which note you changed and what you did.
- Be concise. Use markdown."""


class Runner(Protocol):
    def run(self, prompt: str, session: str | None = None) -> Iterator[dict]: ...


def build_resume_prompt(messages: list[dict], today: date | None = None) -> str:
    """The next question of a Codex session that already has the rules and the earlier turns."""
    question = str(messages[-1].get("content") or "")[:MAX_MESSAGE_CHARS]
    return (f"Today is {today:%A} {today.isoformat()}.\n\n" if today else "") + f"Question from the user (answer this one):\n{question}"


def build_prompt(messages: list[dict], today: date | None = None) -> str:
    """The rules and the last turns; the final message is the question to answer."""
    turns = [{"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("content") or "")[:MAX_MESSAGE_CHARS]}
             for m in messages if str(m.get("content") or "").strip()][-MAX_TURNS:]
    parts = [SYSTEM + (f"\n\nToday is {today:%A} {today.isoformat()}." if today else "")]
    if len(turns) > 1:
        parts.append("Conversation so far:\n" + "\n\n".join(f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['content']}" for t in turns[:-1]))
    parts.append(f"Question from the user (answer this one):\n{turns[-1]['content']}")
    return "\n\n".join(parts)


class ChatService:
    def __init__(self, runner: Runner | None, notes: NoteService, git: GitClient, root: Path, sessions: SessionStore | None = None):
        self.runner, self.notes, self.git, self.root, self.sessions = runner, notes, git, Path(root), sessions

    def reset(self) -> None:
        """Forget the chat's Codex session: the next question starts a new one ("New chat")."""
        if self.sessions:
            self.sessions.clear("chat")

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

    def _run(self, messages: list[dict], session: str | None) -> Iterator[dict]:
        """Resumes the chat's Codex session with just the question. If that cannot be done (the session file is gone) it starts
        a new session with the recent turns replayed; its `session` event then replaces the id."""
        today = self.notes.today()
        if self.sessions:
            session = self.sessions.get("chat") or session  # the server's session wins; the page's is only a first migration
        if session:
            for event in self.runner.run(build_resume_prompt(messages, today), session):
                if event["type"] == "error":
                    break
                yield self._remember(event)
            else:
                return
        for event in self.runner.run(build_prompt(messages, today=today)):
            yield self._remember(event)

    def _remember(self, event: dict) -> dict:
        if event["type"] == "session" and self.sessions:
            self.sessions.set("chat", event["id"])
        return event

    def stream(self, messages: list[dict], session: str | None = None) -> Iterator[dict]:
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
            yield from self._run(messages, session)
        finally:
            self.notes.invalidate()  # the tools saved from another process: re-read what changed on the next request
            try:
                changed = self._changed(before, self._head())
            except Exception:
                log.exception("could not list the notes a chat changed")
        if changed:
            yield {"type": "changed", "notes": changed}

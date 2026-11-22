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


MAX_SELECTION_CHARS = 4_000


def note_scope(slug: str | None, title: str = "", selection: str = "") -> str:
    """Tells the agent which note the user has open, so "this note" and "this paragraph" mean something. Empty without a note."""
    if not slug:
        return ""
    lines = [f"The user is looking at the note `{slug}.md`" + (f' (titled "{title}")' if title else "") + ' in the notes app and is chatting from beside it: "this note" means that file.',
             "Unless they ask otherwise, change only that note (editing its heading renames the file, so only do that when asked)."]
    selection = selection.strip()[:MAX_SELECTION_CHARS]
    if selection:
        lines.append("They have selected this text in the note; it is what they mean by \"this\", \"it\" or \"the selection\":\n<<<\n" + selection + "\n>>>")
    return "\n".join(lines)


def build_resume_prompt(messages: list[dict], today: date | None = None, scope: str = "") -> str:
    """The next question of a Codex session that already has the rules and the earlier turns."""
    question = str(messages[-1].get("content") or "")[:MAX_MESSAGE_CHARS]
    return (f"Today is {today:%A} {today.isoformat()}.\n\n" if today else "") + (scope + "\n\n" if scope else "") + f"Question from the user (answer this one):\n{question}"


def build_prompt(messages: list[dict], today: date | None = None, scope: str = "") -> str:
    """The rules and the last turns; the final message is the question to answer."""
    turns = [{"role": "assistant" if m.get("role") == "assistant" else "user", "content": str(m.get("content") or "")[:MAX_MESSAGE_CHARS]}
             for m in messages if str(m.get("content") or "").strip()][-MAX_TURNS:]
    parts = [SYSTEM + (f"\n\nToday is {today:%A} {today.isoformat()}." if today else "")]
    if scope:
        parts.append(scope)
    if len(turns) > 1:
        parts.append("Conversation so far:\n" + "\n\n".join(f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['content']}" for t in turns[:-1]))
    parts.append(f"Question from the user (answer this one):\n{turns[-1]['content']}")
    return "\n\n".join(parts)


class ChatService:
    def __init__(self, runner: Runner | None, notes: NoteService, git: GitClient, root: Path, sessions: SessionStore | None = None,
                 missing: str = "Codex was not found. Install it or set HIVE_CODEX."):
        self.runner, self.notes, self.git, self.root, self.sessions, self.missing = runner, notes, git, Path(root), sessions, missing

    AGENT_KEYS = ("chat", "chat-agy", "chat-claude")  # the session name of each agent the chat can use

    def reset(self, note: str | None = None) -> None:
        """Forget the chat's Codex session: the next question starts a new one ("New chat"). With a note: only that note's chat."""
        if self.sessions:
            for key in self.AGENT_KEYS:  # whichever agent the chat uses
                self.sessions.clear(f"{key}:note:{note}" if note else key)

    @property
    def key(self) -> str:
        """The name the server keeps the chat's session under (each agent has its own: ids do not carry over)."""
        return getattr(self.runner, "session_key", "chat")

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

    def _renamed(self, before: str | None, after: str | None, slug: str) -> dict | None:
        """The note a run renamed `slug` to (editing its heading renames the file), as {slug, title}, or None."""
        if not before or not after or before == after:
            return None
        for line in self.git.run("diff", "--name-status", "-M20%", before, after, check=False).stdout.splitlines():
            status, _, rest = line.partition("\t")
            old, _, new = rest.partition("\t")
            if status.startswith("R") and old == f"{slug}.md" and new.endswith(".md") and "/" not in new:
                try:
                    return {"slug": new[:-3], "title": self.notes.get(new[:-3]).title}
                except Exception:
                    return None
        return None

    def _move_session(self, old: str, new: str) -> None:
        """A renamed note keeps its chat: the session follows the new file name."""
        if not self.sessions:
            return
        for key in self.AGENT_KEYS:
            session = self.sessions.get(f"{key}:note:{old}")
            if session:
                self.sessions.set(f"{key}:note:{new}", session)
                self.sessions.clear(f"{key}:note:{old}")

    def _run(self, messages: list[dict], session: str | None, scope: str = "", note: str | None = None) -> Iterator[dict]:
        """Resumes the chat's Codex session with just the question. If that cannot be done (the session file is gone) it starts
        a new session with the recent turns replayed; its `session` event then replaces the id. A note's chat has a session of its own."""
        today = self.notes.today()
        key = f"{self.key}:note:{note}" if note else self.key
        if self.sessions:
            session = self.sessions.get(key) or session  # the server's session wins; the page's is only a first migration
        if session:
            for event in self.runner.run(build_resume_prompt(messages, today, scope), session):
                if event["type"] == "error":
                    break
                yield self._remember(event, key)
            else:
                return
        for event in self.runner.run(build_prompt(messages, today=today, scope=scope)):
            yield self._remember(event, key)

    def _remember(self, event: dict, key: str | None = None) -> dict:
        if event["type"] == "session" and self.sessions:
            self.sessions.set(key or self.key, event["id"])
        return event

    def stream(self, messages: list[dict], session: str | None = None, note: str | None = None, selection: str = "") -> Iterator[dict]:
        """Codex's events for the question (the last message), then `changed` (notes it saved) when it ends. With `note` (a slug) the
        chat is about that note: the prompt says so (and quotes `selection`), it has its own session, and if the run renamed the note
        the `changed` event carries `renamed` ({from, slug, title}) and the session moves to the new name."""
        if self.runner is None:
            yield {"type": "error", "message": self.missing}
            return
        if not messages or messages[-1].get("role") != "user" or not str(messages[-1].get("content") or "").strip():
            yield {"type": "error", "message": "Ask a question first."}
            return
        scope = ""
        if note:
            try:
                scope = note_scope(note, self.notes.get(note).title, selection)
            except Exception:
                yield {"type": "error", "message": "That note does not exist (any more)."}
                return
        before = self._head()
        changed: list[dict] = []
        renamed = None
        try:
            yield from self._run(messages, session, scope, note)
        finally:
            self.notes.invalidate()  # the tools saved from another process: re-read what changed on the next request
            try:
                after = self._head()
                changed = self._changed(before, after)
                if note:
                    try:
                        self.notes.get(note)
                    except Exception:  # the note is gone: did this run rename it?
                        renamed = self._renamed(before, after, note)
                        if renamed:
                            self._move_session(note, renamed["slug"])
            except Exception:
                log.exception("could not list the notes a chat changed")
        if changed:
            yield {"type": "changed", "notes": changed, **({"renamed": {"from": note, **renamed}} if renamed else {})}

"""The notes tools the chat's Codex run may use (it has no shell: this is all it can reach). Transport-free: the stdio
MCP server in `infrastructure/chat/notes_mcp.py` only carries these calls. Every write goes through NoteService, so a
changed heading renames the file, links are rewritten and the save is one git commit like any other."""
from __future__ import annotations

from typing import Any, Callable

from src.application.notes.service import NoteService
from src.domain.notes.errors import NoteError

MAX_READ_CHARS = 30_000
SEARCH_LIMIT = 10

_STR = {"type": "string"}


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict:
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}


TOOLS: list[dict] = [
    _tool("search_notes", "Search the notes. Every word must match the title, tags or text (case-insensitive), so use one to three "
          "distinctive words and try synonyms if nothing is found. Returns slug, title, tags, types and a snippet per hit.",
          {"query": _STR, "tag": _STR, "limit": {"type": "integer", "minimum": 1, "maximum": 25}}, ["query"]),
    _tool("read_note", "Read one note by slug: its title, tags, types, status and whole text (a long note is cut).",
          {"slug": _STR}, ["slug"]),
    _tool("list_notes", "List note slugs and titles, newest first, optionally only those with a tag or a type.",
          {"tag": _STR, "type": _STR, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, []),
    _tool("backlinks", "List the notes that link to a note with [[wiki links]].", {"slug": _STR}, ["slug"]),
    _tool("create_note", "Create a note. The title is the first `# heading` of the text (added when missing); the file name follows from it.",
          {"title": _STR, "content": _STR, "tags": {"type": "array", "items": _STR}, "types": {"type": "array", "items": _STR}}, ["title"]),
    _tool("edit_note", "Replace one exact passage of a note's text with new text. `old` must occur exactly once (add context to make "
          "it unique). Prefer this to rewrite_note for small changes. Changing the first `# heading` renames the note.",
          {"slug": _STR, "old": _STR, "new": _STR}, ["slug", "old", "new"]),
    _tool("append_to_note", "Add text at the end of a note.", {"slug": _STR, "text": _STR}, ["slug", "text"]),
    _tool("rewrite_note", "Replace a note's whole text (read it first and keep what should stay). Use only when edit_note cannot do it.",
          {"slug": _STR, "content": _STR}, ["slug", "content"]),
    _tool("set_note_properties", "Change tags, types, status (TODO, IN_PROGRESS, DONE) or priority (must, important, nice-to-have; \"\" removes) "
          "of a note. Leave out what should not change.",
          {"slug": _STR, "tags": {"type": "array", "items": _STR}, "types": {"type": "array", "items": _STR},
           "status": _STR, "priority": _STR}, ["slug"]),
]


class ToolError(Exception):
    """A call the model got wrong; the message tells it how to correct it."""


def _snippet(content: str, words: list[str], width: int = 160) -> str:
    text = " ".join(content.split())
    low = text.casefold()
    at = min((i for i in (low.find(w) for w in words) if i >= 0), default=0)
    start = max(0, at - width // 4)
    return ("…" if start else "") + text[start:start + width] + ("…" if start + width < len(text) else "")


def _head(note) -> str:
    bits = [f"slug: {note.slug}", f"title: {note.title}"]
    if note.tags:
        bits.append("tags: " + ", ".join(note.tags))
    if note.types:
        bits.append("types: " + ", ".join(note.types))
    if note.status:
        bits.append(f"status: {note.status}")
    if note.priority:
        bits.append(f"priority: {note.priority}")
    return " | ".join(bits)


class NotesTools:
    """`call` returns text for the model and records the slugs it wrote in `changed` (a rename lists both)."""

    def __init__(self, service: NoteService):
        self.service = service
        self.changed: list[str] = []

    def call(self, name: str, args: dict | None) -> str:
        args = args or {}
        handler: Callable[..., str] | None = getattr(self, f"_{name}", None) if name in {t["name"] for t in TOOLS} else None
        if handler is None:
            raise ToolError(f"Unknown tool {name}.")
        try:
            return handler(**args)
        except TypeError as error:
            raise ToolError(f"Bad arguments for {name}: {error}") from error
        except NoteError as error:
            raise ToolError(str(error) or type(error).__name__) from error

    def _wrote(self, before: str | None, note) -> str:
        self.changed.extend(s for s in (before, note.slug) if s and s not in self.changed)
        return note.slug

    def _search_notes(self, query: str, tag: str | None = None, limit: int = SEARCH_LIMIT) -> str:
        hits = self.service.search(query, tag or None, max(1, min(int(limit), 25)))
        words = query.casefold().split()
        if not hits:
            return "No notes match. Try fewer or different words."
        return "\n".join(f"- {_head(h.note)}\n  {_snippet(h.note.content, words)}" for h in hits)

    def _read_note(self, slug: str) -> str:
        note = self.service.get(slug)
        body = note.content if len(note.content) <= MAX_READ_CHARS else note.content[:MAX_READ_CHARS] + "\n[note cut]"
        return f"{_head(note)}\n\n{body}"

    def _list_notes(self, tag: str | None = None, type: str | None = None, limit: int = 50) -> str:
        notes = [n for n in self.service.list(tag or None) if not type or type in n.types][:max(1, min(int(limit), 100))]
        return "\n".join(f"- {n.slug}: {n.title}" for n in notes) or "No notes."

    def _backlinks(self, slug: str) -> str:
        notes = self.service.backlinks(slug)
        return "\n".join(f"- {n.slug}: {n.title}" for n in notes) or "No note links here."

    def _create_note(self, title: str, content: str = "", tags: list[str] | None = None, types: list[str] | None = None) -> str:
        note = self.service.create(title, content, tuple(tags or ()), tuple(types or ()))
        return f"Created {self._wrote(None, note)} ({note.title})."

    def _edit_note(self, slug: str, old: str, new: str) -> str:
        note = self.service.get(slug)
        if not old:
            raise ToolError("`old` is empty: use append_to_note to add text.")
        count = note.content.count(old)
        if count != 1:
            raise ToolError("`old` was not found in the note; read it again and copy the text exactly." if count == 0
                            else f"`old` occurs {count} times; include more surrounding text so it occurs once.")
        saved = self.service.update(slug, content=note.content.replace(old, new, 1))
        renamed = f" (renamed to {saved.slug})" if saved.slug != slug else ""
        return f"Edited {self._wrote(slug, saved)}{renamed}."

    def _append_to_note(self, slug: str, text: str) -> str:
        note = self.service.get(slug)
        saved = self.service.update(slug, content=note.content.rstrip("\n") + "\n\n" + text.strip("\n") + "\n")
        return f"Added to {self._wrote(slug, saved)}."

    def _rewrite_note(self, slug: str, content: str) -> str:
        saved = self.service.update(slug, content=content)
        renamed = f" (renamed to {saved.slug})" if saved.slug != slug else ""
        return f"Rewrote {self._wrote(slug, saved)}{renamed}."

    def _set_note_properties(self, slug: str, tags: list[str] | None = None, types: list[str] | None = None,
                             status: str | None = None, priority: str | None = None) -> str:
        if status not in (None, "TODO", "IN_PROGRESS", "DONE"):
            raise ToolError("status must be TODO, IN_PROGRESS or DONE.")
        if priority not in (None, "", "must", "important", "nice-to-have"):
            raise ToolError("priority must be must, important, nice-to-have or empty.")
        saved = self.service.update(slug, tags=None if tags is None else tuple(tags), types=None if types is None else tuple(types),
                                    status=status, priority=priority)
        return f"Updated {self._wrote(slug, saved)}."

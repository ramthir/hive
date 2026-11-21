"""Core domain models for file-backed markdown notes."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class Note:
    """A markdown note. ``slug`` (the filename without ``.md``) is its identity."""

    slug: str
    title: str
    content: str
    tags: tuple[str, ...] = ()
    created: str | None = None
    updated: str | None = None
    status: str | None = None  # the `status:` frontmatter key (TODO / IN_PROGRESS / DONE) used by the task board
    priority: str | None = None  # the `priority:` frontmatter key (must / important / nice-to-have) used by the task board
    week: str | None = None  # the `week:` frontmatter key, an ISO week like 2026-W47: when a task was finished
    types: tuple[str, ...] = ()  # the `type:` frontmatter key: a list like [task] or [contact, interview]; () = unset
    time: dict[str, int] = field(default_factory=dict)  # the `time:` frontmatter key: ISO day -> minutes logged
    # Frontmatter keys the app does not manage; preserved verbatim on save.
    extra: dict[str, Any] = field(default_factory=dict)
    modified: float | None = None  # file mtime; only used to order notes updated on the same day
    # Hash of the file's text when it was read. A save that names it is refused if the file has changed since
    # (NoteConflict); not part of the note's value, so two reads of equal notes compare equal.
    revision: str | None = field(default=None, compare=False)


@dataclass(frozen=True)
class Comparison:
    """One version set against another note state: what the version diff shows."""

    sha: str
    index: int  # 1-based position of the version, newest first
    total: int
    old: "Note | None"  # None: the first version, nothing before it
    new: Note
    version_title: str
    current_title: str
    label_a: str
    label_b: str


@dataclass(frozen=True)
class NoteVersion:
    """One commit that touched a note."""

    sha: str
    message: str
    author: str
    committed_at: datetime
    path: str = ""
    added: int = 0
    removed: int = 0
    kind: str = ""  # what the commit did (src/domain/notes/changes.py); empty when not described
    kinds: tuple[str, ...] = ()
    summary: str = ""
    detail: str = ""
    deleted: bool = False  # this commit removed the note: there is nothing to open or restore

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
    week: str | None = None  # the `week:` frontmatter key, an ISO week like 2026-W47: when a task was finished
    types: tuple[str, ...] = ()  # the `type:` frontmatter key: a list like [task] or [contact, interview]; () = unset
    time: dict[str, int] = field(default_factory=dict)  # the `time:` frontmatter key: ISO day -> minutes logged
    # Frontmatter keys the app does not manage; preserved verbatim on save.
    extra: dict[str, Any] = field(default_factory=dict)
    modified: float | None = None  # file mtime; only used to order notes updated on the same day


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

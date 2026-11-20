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
    # Frontmatter keys the app does not manage; preserved verbatim on save.
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NoteVersion:
    """One commit that touched a note."""

    sha: str
    message: str
    author: str
    committed_at: datetime
    path: str = ""

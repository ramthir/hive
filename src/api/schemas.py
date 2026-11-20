from __future__ import annotations

from datetime import datetime
from typing import Any

import re

from pydantic import BaseModel, Field

from src.domain.notes.entities import Note, NoteVersion


def snippet(content: str, length: int = 200) -> str:
    plain = re.sub(r"[#*`_>\[\]]", " ", content or "")
    return " ".join(plain.split())[:length]


class NoteSummary(BaseModel):
    slug: str
    title: str
    tags: list[str]
    created: str | None
    updated: str | None
    score: int | None = None
    snippet: str = ""

    @classmethod
    def of(cls, n: Note, score: int | None = None) -> "NoteSummary":
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   score=score, snippet=snippet(n.content))


class NoteDetail(NoteSummary):
    content: str
    extra: dict[str, Any]

    @classmethod
    def of(cls, n: Note) -> "NoteDetail":  # type: ignore[override]
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   snippet=snippet(n.content), content=n.content, extra=dict(n.extra))


class NoteCreate(BaseModel):
    title: str = Field(min_length=1)
    content: str = ""
    tags: list[str] = []
    slug: str | None = None


class NoteUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    content: str | None = None
    tags: list[str] | None = None


class RenameRequest(BaseModel):
    slug: str


class VersionOut(BaseModel):
    sha: str
    message: str
    author: str
    committed_at: datetime

    @classmethod
    def of(cls, v: NoteVersion) -> "VersionOut":
        return cls(sha=v.sha, message=v.message, author=v.author, committed_at=v.committed_at)


class VersionDetail(VersionOut):
    title: str
    content: str
    tags: list[str]


class DiffOut(BaseModel):
    sha: str
    against: str
    diff: str


class BacklinksOut(BaseModel):
    backlinks: list[NoteSummary]
    links: list[str]
    unresolved: list[str]


class ResolvedLink(BaseModel):
    slug: str
    title: str

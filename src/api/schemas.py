from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

import re

from pydantic import BaseModel, Field

from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.tasks import WEEK_PATTERN, TaskPriority, TaskStatus, task_priority, task_status, task_week, without_priority
from src.domain.notes.title import with_h1


def snippet(content: str, length: int = 200) -> str:
    plain = re.sub(r"[#*`_>\[\]]", " ", content or "")
    return " ".join(plain.split())[:length]


class NoteSummary(BaseModel):
    slug: str
    title: str
    tags: list[str]
    created: str | None
    updated: str | None
    types: list[str] = []
    status: str | None = None  # the stored `status:`; /api/tasks adds the derived one
    week: str | None = None  # ISO week a task was finished, e.g. 2026-W47
    score: int | None = None
    snippet: str = ""

    @classmethod
    def of(cls, n: Note, score: int | None = None) -> "NoteSummary":
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   types=list(n.types), status=n.status, week=n.week, score=score, snippet=snippet(n.content))


class NoteDetail(NoteSummary):
    content: str
    extra: dict[str, Any]

    @classmethod
    def of(cls, n: Note) -> "NoteDetail":  # type: ignore[override]
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   types=list(n.types), status=n.status, week=n.week, snippet=snippet(n.content), content=with_h1(n.title, n.content), extra=dict(n.extra))


class NoteCreate(BaseModel):
    """The title is the content's first `# heading`; `title` is only used when the content has none."""
    title: str | None = None
    content: str = ""
    tags: list[str] = []
    types: list[str] = []


class NoteUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    content: str | None = None
    tags: list[str] | None = None
    types: list[str] | None = None  # omitted: unchanged; []: clear
    status: TaskStatus | None = None  # omitted: unchanged
    priority: TaskPriority | Literal[""] | None = None  # replaces the priority tag; "" removes it; omitted: tags as given
    week: str | None = Field(default=None, pattern=WEEK_PATTERN)  # omitted: unchanged (set automatically with status)


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


class TaskOut(NoteSummary):
    """A task note on the board: `status` is the effective one (stored, else derived from the `done` tag);
    `week_key` is the stored `week` or else the week of `updated`, and `week_stored` says which. The priority is
    its own field, so `tags` leaves out the priority tag."""

    priority: TaskPriority | None = None
    week_key: str | None = None
    week_stored: bool = False

    @classmethod
    def from_task(cls, n: Note) -> "TaskOut":
        week_key, week_stored = task_week(n)
        return cls(**{**NoteSummary.of(n).model_dump(), "status": task_status(n), "tags": list(without_priority(n.tags)), "priority": task_priority(n.tags), "week_key": week_key, "week_stored": week_stored})

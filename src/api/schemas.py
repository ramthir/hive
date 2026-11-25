from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from src.application.notes.time_entries import TimeRow
from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.properties import form_for
from src.domain.notes.time import MAX_MINUTES_PER_DAY, TimeKind, accepts_time, time_type
from src.domain.notes.properties import SpecStatus
from src.domain.notes.tasks import WEEK_PATTERN, TaskPriority, TaskStatus, is_task, task_priority, task_status, task_week, without_priority
from src.domain.notes.title import with_h1


def snippet(content: str, length: int = 200) -> str:
    plain = re.sub(r"[#*`_>\[\]]", " ", content or "")
    return " ".join(plain.split())[:length]


def role_of(n: Note) -> str | None:
    """The `role:` key as plain text: `[[Senior Engineer]]` and `[[senior-engineer|Senior Engineer]]` both read as the name."""
    value = str(n.extra.get("role") or "").strip()
    match = re.fullmatch(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", value)
    return ((match.group(2) or match.group(1)).strip() if match else value) or None


class NoteSummary(BaseModel):
    slug: str
    title: str
    tags: list[str]
    created: str | None
    updated: str | None
    types: list[str] = []
    status: str | None = None  # the stored `status:`; /api/tasks adds the derived one
    week: str | None = None  # ISO week a task was finished, e.g. 2026-W47
    role: str | None = None  # the `role:` key (a contact's job), shown in the note search
    score: int | None = None
    snippet: str = ""

    @classmethod
    def of(cls, n: Note, score: int | None = None) -> "NoteSummary":
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   types=list(n.types), status=n.status, week=n.week, role=role_of(n), score=score, snippet=snippet(n.content))


class NoteDetail(NoteSummary):
    content: str
    time: dict[str, int] = {}  # ISO day -> minutes logged (task and meeting notes)
    takes_time: bool = False  # a task or meeting: time can be logged on it
    has_properties: bool = False  # the note's type has a properties drawer (GET /notes/{slug}/properties)
    revision: str | None = None  # changes whenever the file's text does; send it back in PUT to detect edits made meanwhile
    task_status: str | None = None  # a task's effective status (the stored one, else derived from a `done` tag); None for other notes
    priority: str | None = None  # a task's priority (the `priority:` key, else an older priority tag); None for other notes
    extra: dict[str, Any]

    @classmethod
    def from_note(cls, n: Note) -> "NoteDetail":
        return cls(slug=n.slug, title=n.title, tags=list(n.tags), created=n.created, updated=n.updated,
                   types=list(n.types), status=n.status, week=n.week, role=role_of(n), snippet=snippet(n.content), content=with_h1(n.title, n.content), time=dict(n.time), takes_time=accepts_time(n), has_properties=form_for(n.types) is not None, revision=n.revision,
                   task_status=task_status(n) if is_task(n) else None, priority=task_priority(n) if is_task(n) else None, extra=dict(n.extra))


class TimeEntryOut(BaseModel):
    """One note's minutes on one day. `id` is `slug:day`."""
    id: str
    slug: str
    title: str
    type: TimeKind | Literal["other"]  # "other": time left on a note that is no longer a task or meeting
    project: str
    day: str
    minutes: int

    @classmethod
    def of(cls, r: TimeRow) -> "TimeEntryOut":
        return cls(id=r.id, slug=r.slug, title=r.title, type=r.type, project=r.project, day=r.day, minutes=r.minutes)


class TimeEntryListItemOut(TimeEntryOut):
    project_label: str
    project_slug: str | None


class TimeItemOut(BaseModel):
    title: str
    project: str
    minutes: int


class TimeDayOut(BaseModel):
    day: str
    minutes: int
    items: list[TimeItemOut]


class TimeEntriesOut(BaseModel):
    """A page of entries plus the current month (by the server's clock) over everything the search matched:
    totals, today's minutes and, per day with time, what it was spent on (the cards' sparkline)."""
    items: list[TimeEntryListItemOut]
    total: int
    month: str
    today: str
    today_minutes: int
    days: list[TimeDayOut]
    total_entries: int
    total_minutes: int
    task_minutes: int
    meeting_minutes: int
    page: int
    page_size: int
    total_pages: int


class TimeNoteOut(BaseModel):
    """A note that takes time, for the picker: `this_week` when it was edited or had time logged this week."""
    slug: str
    title: str
    type: TimeKind
    this_week: bool

    @classmethod
    def of(cls, n: Note, this_week: bool) -> "TimeNoteOut":
        return cls(slug=n.slug, title=n.title, type=time_type(n), this_week=this_week)


class TimeLog(BaseModel):
    minutes: int = Field(ge=1, le=MAX_MINUTES_PER_DAY)


class TimeAdd(TimeLog):
    day: str  # YYYY-MM-DD; the service rejects anything else


class TimeMove(TimeAdd):
    slug: str  # the note the time moves to


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
    status: TaskStatus | SpecStatus | None = None  # omitted: unchanged
    priority: TaskPriority | Literal[""] | None = None  # stored in the `priority` key; "" removes it; omitted: unchanged
    week: str | None = Field(default=None, pattern=WEEK_PATTERN + "|^$")  # omitted: unchanged (set automatically with status); "" clears
    properties: dict[str, str] | None = None  # the type's own fields, e.g. {"project": "Acme"}; "" removes one; omitted: unchanged
    revision: str | None = None  # the `revision` the edit is based on; if the note has changed since, 412 instead of overwriting


class PropertyChoice(BaseModel):
    value: str
    label: str


class PropertyShowWhen(BaseModel):
    key: str
    value: str


class PropertyFieldOut(BaseModel):
    """One field of the properties drawer. `target` says which key of `PUT /notes/{slug}` carries it: `property` fields go
    in `properties` under their `key`; `tags`, `status`, `priority` and `week` are top-level keys of the update."""
    key: str
    label: str
    icon: str
    kind: Literal["text", "select", "note", "values", "tags"]
    target: Literal["property", "tags", "status", "priority", "week"]
    group: str | None
    placeholder: str
    required: bool
    wide: bool
    show_when: PropertyShowWhen | None
    multiple: bool = False
    value: str
    choices: list[PropertyChoice]


class PropertiesOut(BaseModel):
    title: str  # the drawer's heading, from the note's type: "Task Properties"
    groups: dict[str, str]
    fields: list[PropertyFieldOut]


class VersionOut(BaseModel):
    sha: str
    message: str
    author: str
    committed_at: datetime
    added: int = 0
    removed: int = 0
    kind: str = ""
    kinds: list[str] = []
    summary: str = ""
    detail: str = ""
    deleted: bool = False

    @classmethod
    def of(cls, v: NoteVersion) -> "VersionOut":
        return cls(sha=v.sha, message=v.message, author=v.author, committed_at=v.committed_at, added=v.added, removed=v.removed,
                   kind=v.kind, kinds=list(v.kinds), summary=v.summary, detail=v.detail, deleted=v.deleted)


class VersionDetail(VersionOut):
    title: str
    content: str
    tags: list[str]


class PropertyChangeOut(BaseModel):
    key: str
    old: str | None
    new: str | None
    minor: bool = False


class DiffOut(BaseModel):
    sha: str
    against: str
    diff: str  # unified diff of the note text; the frontmatter changes are in `properties`
    properties: list[PropertyChangeOut] = []
    index: int = 0  # 1-based position of this version, newest first
    total: int = 0
    version_title: str = ""
    current_title: str = ""


class BacklinksOut(BaseModel):
    backlinks: list[NoteSummary]
    links: list[str]
    unresolved: list[str]


class ResolvedLink(BaseModel):
    slug: str
    title: str
    types: list[str] = []  # lets a page link straight to a note's read page instead of going through /notes/{slug}


class TaskOut(NoteSummary):
    """A task note on the board: `status` is the effective one (stored, else derived from the `done` tag);
    `week_key` is the stored `week` or else the week of `updated`, and `week_stored` says which. The priority is
    its own field, so `tags` leaves out the priority tag."""

    priority: TaskPriority | None = None
    week_key: str | None = None
    week_stored: bool = False
    ticket: str | None = None
    project: str | None = None

    @classmethod
    def from_task(cls, n: Note) -> "TaskOut":
        week_key, week_stored = task_week(n)
        return cls(**{
            **NoteSummary.of(n).model_dump(),
            "status": task_status(n),
            "tags": list(without_priority(n.tags)),
            "priority": task_priority(n),
            "week_key": week_key,
            "week_stored": week_stored,
            "ticket": str(n.extra.get("ticket") or "").strip() or None,
            "project": str(n.extra.get("project") or "").strip() or None,
        })

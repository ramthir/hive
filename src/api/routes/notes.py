from __future__ import annotations

import difflib
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response

from src.api.schemas import (BacklinksOut, DiffOut, NoteCreate, NoteDetail, NoteSummary, NoteUpdate,
                             PropertiesOut, PropertyChangeOut, ResolvedLink, TaskOut, TimeAdd, TimeEntriesOut, TimeEntryOut, TimeLog, TimeMove, TimeNoteOut, VersionDetail,
                             VersionOut)
from src.application.notes.service import NoteService
from src.domain.notes.changes import KINDS, property_changes
from src.domain.notes.errors import NoteNotFound

router = APIRouter()
VersionKind = Literal[(*KINDS, "deleted")]


def svc(request: Request) -> NoteService:
    return request.app.state.notes


# Plain `def` handlers: FastAPI runs them in a threadpool, so git subprocesses don't block the loop.

@router.get("/notes", response_model=list[NoteSummary])
def list_notes(request: Request, q: str = "", tag: str | None = None, limit: int = Query(50, ge=1, le=1000),
               sort: str = Query("title", pattern="^(title|recent)$")):
    """With `q` or `tag`: ranked search. Otherwise all notes, by title or (`sort=recent`) most recently edited first."""
    s = svc(request)
    if q or tag:
        return [NoteSummary.of(h.note, h.score) for h in s.search(q, tag, limit)]
    notes = s.recent() if sort == "recent" else s.list()
    return [NoteSummary.of(n) for n in notes[:limit]]


@router.post("/notes", response_model=NoteDetail, status_code=201)
def create_note(request: Request, body: NoteCreate):
    return NoteDetail.from_note(svc(request).create(body.title, body.content, tuple(body.tags), tuple(body.types)))


@router.get("/latest", response_model=NoteDetail)
def latest_note(request: Request):
    """The most recently edited note (what the app opens at /)."""
    return NoteDetail.from_note(svc(request).latest())


@router.get("/tasks", response_model=list[TaskOut])
def tasks(request: Request):
    """The task board: every note of type `task`, most recently edited first, with its effective status."""
    return [TaskOut.from_task(n) for n in svc(request).tasks()]


@router.get("/tasks/current-week")
def current_week(request: Request) -> dict[str, str]:
    """This week (e.g. 2026-W47) by the server's clock: the default week of the Done column."""
    return {"week": svc(request).current_week()}


@router.get("/time-entries", response_model=TimeEntriesOut)
def time_entries(request: Request, q: str = "", start: date | None = None, end: date | None = None,
                 note: str | None = None, page: int = Query(0, ge=0), page_size: int = Query(10, ge=1, le=100)):
    """Logged time (one row per task or meeting note and day), newest first. `q` takes free text (the note title)
    and `project:`, `task:`, `date:today|yesterday|YYYY-MM-DD`, `duration:>30m` filters. The totals are this
    month's, over every match, not only the page."""
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    s = svc(request)
    rows = s.time_rows(query=q, start=start and start.isoformat(), end=end and end.isoformat(), slug=note)
    shown = rows[page * page_size:(page + 1) * page_size]
    return TimeEntriesOut(items=[TimeEntryOut.of(r) for r in shown], total=len(rows), page=page, page_size=page_size,
                          total_pages=max(1, -(-len(rows) // page_size)), **s.time_summary(rows))


@router.get("/time-notes", response_model=list[TimeNoteOut])
def time_notes(request: Request):
    """The tasks and meetings time can be logged on: this week's first (edited or logged this week, newest first),
    then the rest by title."""
    return [TimeNoteOut.of(n, this_week) for n, this_week in svc(request).time_notes()]


@router.post("/notes/{slug}/time", response_model=TimeEntryOut, status_code=201)
def add_time(request: Request, slug: str, body: TimeAdd):
    """Add minutes to a day (a new day is created)."""
    return TimeEntryOut.of(svc(request).log_time(slug, body.day, body.minutes, add=True))


@router.put("/notes/{slug}/time/{day}", response_model=TimeEntryOut)
def set_time(request: Request, slug: str, day: str, body: TimeLog):
    """Set the minutes of a day, replacing what was there."""
    return TimeEntryOut.of(svc(request).log_time(slug, day, body.minutes))


@router.post("/notes/{slug}/time/{day}/move", response_model=TimeEntryOut)
def move_time(request: Request, slug: str, day: str, body: TimeMove):
    """Move a day's time to another note and/or day, adding to what is there; one commit."""
    return TimeEntryOut.of(svc(request).move_time(slug, day, body.slug, body.day, body.minutes))


@router.delete("/notes/{slug}/time/{day}", status_code=204)
def remove_time(request: Request, slug: str, day: str):
    svc(request).remove_time(slug, day)
    return Response(status_code=204)


@router.get("/tags", response_model=dict[str, int])
def tags(request: Request):
    return svc(request).tags()


@router.get("/resolve", response_model=dict[str, ResolvedLink | None])
def resolve(request: Request, target: list[str] = Query(default=[])):
    """Resolve wikilink targets (slug, title, or loose title) to notes; unknown targets map to null."""
    index = svc(request).index
    out: dict[str, ResolvedLink | None] = {}
    for t in target:
        slug = index.resolve(t)
        out[t] = ResolvedLink(slug=slug, title=index.notes[slug].title) if slug else None
    return out


@router.get("/types", response_model=dict[str, int])
def types(request: Request):
    """The note types in use, with counts."""
    return svc(request).types()


@router.post("/reindex", status_code=204)
def reindex(request: Request):
    svc(request).invalidate()


@router.get("/notes/{slug}", response_model=NoteDetail)
def get_note(request: Request, slug: str):
    return NoteDetail.from_note(svc(request).get(slug))


@router.put("/notes/{slug}", response_model=NoteDetail)
def update_note(request: Request, slug: str, body: NoteUpdate):
    return NoteDetail.from_note(svc(request).update(
        slug, title=body.title, content=body.content,
        tags=None if body.tags is None else tuple(body.tags),
        types=None if body.types is None else tuple(body.types), status=body.status, week=body.week, priority=body.priority,
        properties=body.properties, revision=body.revision))


@router.get("/notes/{slug}/properties", response_model=PropertiesOut)
def note_properties(request: Request, slug: str):
    """The properties drawer of a note: the fields of its type with their values and choices (404 if the type has none)."""
    form = svc(request).property_form(slug)
    if form is None:
        raise HTTPException(status_code=404, detail="This note's type has no properties.")
    return form


@router.delete("/notes/{slug}", status_code=204)
def delete_note(request: Request, slug: str):
    svc(request).delete(slug)
    return Response(status_code=204)


@router.get("/notes/{slug}/backlinks", response_model=BacklinksOut)
def backlinks(request: Request, slug: str):
    s = svc(request)
    back = s.backlinks(slug)
    return BacklinksOut(
        backlinks=[NoteSummary.of(n) for n in back],
        links=s.index.links_from(slug),
        unresolved=s.index.unresolved.get(slug, []),
    )


@router.get("/notes/{slug}/versions", response_model=list[VersionOut])
def versions(request: Request, slug: str, limit: int | None = Query(None, ge=1, le=200), offset: int = Query(0, ge=0),
             kind: VersionKind | None = Query(None)):
    """Newest first. Without `limit` every version; a page that comes back with `limit` rows may have more. `kind`
    (text, properties, time, restore, ...) keeps only the versions that include that kind of change; `limit` and `offset`
    then count the versions that match."""
    return [VersionOut.of(v) for v in svc(request).version_changes(slug, limit, offset, kind)]


def _find(s: NoteService, slug: str, sha: str):
    v = next((v for v in s.versions(slug) if v.sha.startswith(sha)), None)
    if v is None:
        raise NoteNotFound(f"{slug}@{sha}")
    return v


@router.get("/notes/{slug}/versions/{sha}", response_model=VersionDetail)
def get_version(request: Request, slug: str, sha: str):
    s = svc(request)
    v = _find(s, slug, sha)
    n = s.get_version(slug, v.sha)
    return VersionDetail(**VersionOut.of(v).model_dump(), title=n.title, content=n.content, tags=list(n.tags))


@router.get("/notes/{slug}/versions/{sha}/diff", response_model=DiffOut)
def version_diff(request: Request, slug: str, sha: str, against: str = Query("previous", pattern="^(previous|current)$")):
    """This version vs. its previous version, or vs. the current note: the text as a unified diff, the frontmatter keys
    that changed (tags, status, time...) as `properties`, and where the version sits in the history."""
    c = svc(request).compare_version(slug, sha, against)
    diff = "".join(difflib.unified_diff((c.old.content if c.old else "").splitlines(True), c.new.content.splitlines(True), c.label_a, c.label_b))
    return DiffOut(sha=c.sha, against=against, diff=diff, properties=[PropertyChangeOut(**vars(p)) for p in property_changes(c.old, c.new)],
                   index=c.index, total=c.total, version_title=c.version_title, current_title=c.current_title)


@router.post("/notes/{slug}/versions/{sha}/restore", response_model=NoteDetail)
def restore_version(request: Request, slug: str, sha: str):
    s = svc(request)
    return NoteDetail.from_note(s.restore(slug, _find(s, slug, sha).sha))

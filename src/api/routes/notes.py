from __future__ import annotations

import difflib

from fastapi import APIRouter, Query, Request, Response

from src.api.schemas import (BacklinksOut, DiffOut, NoteCreate, NoteDetail, NoteSummary, NoteUpdate,
                             RenameRequest, ResolvedLink, VersionDetail, VersionOut)
from src.application.notes.service import NoteService
from src.domain.notes.errors import NoteNotFound

router = APIRouter()


def svc(request: Request) -> NoteService:
    return request.app.state.notes


# Plain `def` handlers: FastAPI runs them in a threadpool, so git subprocesses don't block the loop.

@router.get("/notes", response_model=list[NoteSummary])
def list_notes(request: Request, q: str = "", tag: str | None = None, limit: int = Query(50, ge=1, le=1000)):
    s = svc(request)
    if q or tag:
        return [NoteSummary.of(h.note, h.score) for h in s.search(q, tag, limit)]
    return [NoteSummary.of(n) for n in s.list()[:limit]]


@router.post("/notes", response_model=NoteDetail, status_code=201)
def create_note(request: Request, body: NoteCreate):
    return NoteDetail.of(svc(request).create(body.title, body.content, tuple(body.tags), body.slug))


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


@router.post("/reindex", status_code=204)
def reindex(request: Request):
    svc(request).invalidate()


@router.get("/notes/{slug}", response_model=NoteDetail)
def get_note(request: Request, slug: str):
    return NoteDetail.of(svc(request).get(slug))


@router.put("/notes/{slug}", response_model=NoteDetail)
def update_note(request: Request, slug: str, body: NoteUpdate):
    return NoteDetail.of(svc(request).update(
        slug, title=body.title, content=body.content,
        tags=None if body.tags is None else tuple(body.tags)))


@router.delete("/notes/{slug}", status_code=204)
def delete_note(request: Request, slug: str):
    svc(request).delete(slug)
    return Response(status_code=204)


@router.post("/notes/{slug}/rename", response_model=NoteDetail)
def rename_note(request: Request, slug: str, body: RenameRequest):
    return NoteDetail.of(svc(request).rename(slug, body.slug))


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
def versions(request: Request, slug: str):
    return [VersionOut.of(v) for v in svc(request).versions(slug)]


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
    """Unified diff of the note body: this version vs. its previous version, or vs. the current note."""
    s = svc(request)
    history = s.versions(slug)
    v = _find(s, slug, sha)
    new = s.get_version(slug, v.sha).content
    if against == "current":
        old, new = new, s.get(slug).content
        label_a, label_b = v.sha[:7], "current"
    else:
        i = history.index(v)
        old = s.get_version(slug, history[i + 1].sha).content if i + 1 < len(history) else ""
        label_a, label_b = (history[i + 1].sha[:7] if i + 1 < len(history) else "empty"), v.sha[:7]
    diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), label_a, label_b))
    return DiffOut(sha=v.sha, against=against, diff=diff)


@router.post("/notes/{slug}/versions/{sha}/restore", response_model=NoteDetail)
def restore_version(request: Request, slug: str, sha: str):
    s = svc(request)
    return NoteDetail.of(s.restore(slug, _find(s, slug, sha).sha))

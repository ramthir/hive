"""Use cases over a NoteRepository, with a lazily rebuilt index."""
from __future__ import annotations

import threading
from dataclasses import replace

from src.application.notes.index import NoteIndex, SearchHit
from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.errors import NoteExists
from src.domain.notes.repositories import NoteRepository
from src.domain.notes.slug import slugify, validate_slug
from src.domain.notes.wiki_links import rewrite_targets
from src.infrastructure.metrics import Metrics


class NoteService:
    def __init__(self, repo: NoteRepository, metrics: Metrics | None = None):
        self.repo = repo
        self.metrics = metrics or Metrics()
        self._index: NoteIndex | None = None
        self._lock = threading.Lock()

    # -- index -----------------------------------------------------------
    def invalidate(self) -> None:
        """Drop the index (call after writes, or when files change outside the app).
        The rebuild is lazy: nothing is read until the next query."""
        with self._lock:
            self._index = None
        self.metrics.incr("index_invalidations")

    @property
    def index(self) -> NoteIndex:
        with self._lock:
            if self._index is None:
                with self.metrics.time("index_rebuild"):
                    self._index = NoteIndex(self.repo.list())
            return self._index

    # -- queries ---------------------------------------------------------
    def list(self, tag: str | None = None) -> list[Note]:
        notes = sorted(self.index.notes.values(), key=lambda n: n.title.casefold())
        return [n for n in notes if tag in n.tags] if tag else notes

    def get(self, slug: str) -> Note:
        return self.repo.get(slug)

    def search(self, query: str = "", tag: str | None = None, limit: int = 50) -> list[SearchHit]:
        return self.index.search(query, tag, limit)

    def backlinks(self, slug: str) -> list[Note]:
        self.repo.get(slug)  # raises NoteNotFound
        return self.index.backlinks(slug)

    def tags(self) -> dict[str, int]:
        return self.index.tags()

    def versions(self, slug: str) -> list[NoteVersion]:
        return self.repo.versions(slug)

    def get_version(self, slug: str, sha: str) -> Note:
        return self.repo.get_version(slug, sha)

    # -- commands --------------------------------------------------------
    def create(self, title: str, content: str = "", tags: tuple[str, ...] = (), slug: str | None = None) -> Note:
        if slug:
            slug = validate_slug(slug)
        else:
            base = slugify(title)
            slug, n = base, 2
            while slug in self.index.notes:
                slug, n = f"{base}-{n}", n + 1
        if slug in self.index.notes:
            raise NoteExists(slug)
        note = self.repo.create(Note(slug=slug, title=title, content=content, tags=tuple(tags)))
        self.invalidate()
        return note

    def update(self, slug: str, *, title: str | None = None, content: str | None = None,
               tags: tuple[str, ...] | None = None) -> Note:
        current = self.repo.get(slug)
        note = self.repo.update(replace(
            current,
            title=current.title if title is None else title,
            content=current.content if content is None else content,
            tags=current.tags if tags is None else tuple(tags),
        ))
        self.invalidate()
        return note

    def rename(self, slug: str, new_slug: str) -> Note:
        """Rename the file and rewrite slug-form links (``[[old]]``) in other notes so they keep
        resolving. Title-form links need no change."""
        new_slug = validate_slug(new_slug)
        linking = [n.slug for n in self.index.backlinks(slug)]
        note = self.repo.rename(slug, new_slug)
        self.invalidate()
        for other in linking:
            current = self.repo.get(other)
            fixed = rewrite_targets(current.content, lambda t: new_slug if t == slug else None)
            if fixed != current.content:
                self.repo.update(replace(current, content=fixed))
        self.invalidate()
        return note

    def delete(self, slug: str) -> None:
        self.repo.delete(slug)
        self.invalidate()

    def restore(self, slug: str, sha: str) -> Note:
        note = self.repo.restore(slug, sha)
        self.invalidate()
        return note

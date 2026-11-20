"""Use cases over a NoteRepository, with a lazily rebuilt index.

A note's title is its first heading (`# Title`) and its file name is the kebab-case of that title.
Changing the heading renames the file, and links to the note are rewritten so they keep working.
"""
from __future__ import annotations

import threading
from datetime import date
from dataclasses import replace

from src.application.notes.index import NoteIndex, SearchHit
from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.errors import InvalidTitle, NoteNotFound
from src.domain.notes.repositories import NoteRepository
from src.domain.notes.slug import slugify
from src.domain.notes.tasks import is_task, task_status, week_label, with_priority
from src.domain.notes.title import extract_h1, set_h1, with_h1
from src.domain.notes.wiki_links import rewrite_targets
from src.infrastructure.metrics import Metrics

def _clean(types) -> tuple[str, ...]:
    """Trimmed, de-duplicated, order-preserving."""
    return tuple(dict.fromkeys(t.strip() for t in types if t and t.strip()))


EMPTY_TITLE = "The note needs a title: start it with a '# Title' heading."


class NoteService:
    def __init__(self, repo: NoteRepository, metrics: Metrics | None = None, today=date.today):
        self.repo = repo
        self._today = today
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

    def current_week(self) -> str:
        """This week in the service's clock, the one finished tasks are stamped with."""
        return week_label(self._today())

    def tasks(self) -> list[Note]:
        """The notes of type `task`, most recently edited first."""
        return [n for n in self.recent() if is_task(n)]

    def get(self, slug: str) -> Note:
        return self.repo.get(slug)

    def recent(self) -> list[Note]:
        """Notes by most recent edit: newest `updated` day first, then newest file modification time."""
        return sorted(self.index.notes.values(), key=lambda n: (n.updated or "", n.modified or 0.0, n.slug), reverse=True)

    def latest(self) -> Note:
        notes = self.recent()
        if not notes:
            raise NoteNotFound("no notes yet")
        return notes[0]

    def search(self, query: str = "", tag: str | None = None, limit: int = 50) -> list[SearchHit]:
        return self.index.search(query, tag, limit)

    def backlinks(self, slug: str) -> list[Note]:
        self.repo.get(slug)  # raises NoteNotFound
        return self.index.backlinks(slug)

    def tags(self) -> dict[str, int]:
        return self.index.tags()

    def types(self) -> dict[str, int]:
        return self.index.types()

    def versions(self, slug: str) -> list[NoteVersion]:
        return self.repo.versions(slug)

    def get_version(self, slug: str, sha: str) -> Note:
        return self.repo.get_version(slug, sha)

    # -- helpers ---------------------------------------------------------
    def _unique_slug(self, title: str, keep: str | None = None) -> str:
        base = slugify(title)
        taken = set(self.index.notes) - {keep}
        slug, n = base, 2
        while slug in taken:
            slug, n = f"{base}-{n}", n + 1
        return slug

    # -- commands --------------------------------------------------------
    def create(self, title: str | None = None, content: str = "", tags: tuple[str, ...] = (),
               types: tuple[str, ...] = ()) -> Note:
        """The title is the content's first heading; `title` is used (and inserted as the heading) if it has none."""
        heading = extract_h1(content)
        title = heading if heading is not None else (title or "").strip()
        if not title:
            raise InvalidTitle(EMPTY_TITLE)
        note = self.repo.create(Note(
            slug=self._unique_slug(title), title=title, content=with_h1(title, content), tags=tuple(tags),
            types=_clean(types)))
        self.invalidate()
        return note

    def update(self, slug: str, *, title: str | None = None, content: str | None = None,
               tags: tuple[str, ...] | None = None, types: tuple[str, ...] | None = None,
               status: str | None = None, week: str | None = None, priority: str | None = None) -> Note:
        """`types` None leaves them unchanged; an empty list clears them. `status` None leaves it unchanged.
        Moving a task to DONE records the week it was finished in `week` (unless `week` is given); moving it out
        of DONE clears it again. `week` None leaves it unchanged otherwise. `priority` (must / important / nice-to-have,
        "" for none) replaces the priority tag among the new `tags` (or the current ones); None leaves them as given."""
        current = self.repo.get(slug)
        new_types = current.types if types is None else _clean(types)
        new_status = current.status if status is None else status
        new_week = current.week if week is None else week
        new_tags = current.tags if tags is None else tuple(tags)
        if priority is not None:
            new_tags = with_priority(new_tags, priority or None)
        if status is not None and week is None:
            before, after = task_status(current), task_status(replace(current, status=status))
            if after == "DONE" and before != "DONE":
                new_week = week_label(self._today())
            elif before == "DONE" and after != "DONE":
                new_week = None
        body = current.content if content is None else content
        if title is not None:
            body = set_h1(body, title.strip())
        new_title = extract_h1(body)
        if new_title is None:  # no heading at all: keep the existing title as the heading
            new_title, body = current.title, with_h1(current.title, body)
        if not new_title:
            raise InvalidTitle(EMPTY_TITLE)

        new_slug = slug
        if new_title != current.title and slugify(new_title) != slug:
            new_slug = self._unique_slug(new_title, keep=slug)
        if new_slug != slug:
            linking = [n.slug for n in self.index.backlinks(slug)]
            self.repo.rename(slug, new_slug)
            self.invalidate()
            note = self.repo.update(replace(
                current, slug=new_slug, title=new_title, content=body, types=new_types,
                status=new_status, week=new_week,
                tags=new_tags))
            self._relink(linking, slug, new_slug, current.title, new_title)
        else:
            note = self.repo.update(replace(
                current, title=new_title, content=body, types=new_types,
                status=new_status, week=new_week,
                tags=new_tags))
        self.invalidate()
        return note

    def _relink(self, linking: list[str], old_slug: str, new_slug: str, old_title: str, new_title: str) -> None:
        """Keep `[[old-slug]]` and `[[Old Title]]` links in other notes pointing at the renamed note."""
        def mapping(target: str) -> str | None:
            if target == old_slug:
                return new_slug
            if target.casefold() == old_title.casefold():
                return new_title
            return None

        for other in linking:
            current = self.repo.get(other)
            fixed = rewrite_targets(current.content, mapping)
            if fixed != current.content:
                self.repo.update(replace(current, content=fixed))

    def delete(self, slug: str) -> None:
        self.repo.delete(slug)
        self.invalidate()

    def restore(self, slug: str, sha: str) -> Note:
        """Restoring an old version also restores its title; if that changes the title the file is renamed too."""
        before = self.repo.get(slug).title
        linking = [n.slug for n in self.index.backlinks(slug)]
        note = self.repo.restore(slug, sha)
        if note.title != before and slugify(note.title) != slug:
            new_slug = self._unique_slug(note.title, keep=slug)
            if new_slug != slug:
                note = self.repo.rename(slug, new_slug)
                self.invalidate()
                self._relink(linking, slug, new_slug, before, note.title)
        self.invalidate()
        return note

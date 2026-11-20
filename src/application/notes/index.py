"""In-memory, rebuildable index over notes: link resolution, backlinks, tags, search."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

from src.domain.notes.entities import Note
from src.domain.notes.wiki_links import extract_targets


@dataclass(frozen=True)
class SearchHit:
    note: Note
    score: int


def _norm(text: str) -> str:
    """Casefold and drop punctuation so 'ADR: X' and 'ADR X' compare equal."""
    return " ".join(re.sub(r"[^\w]+", " ", text.casefold()).split())


class NoteIndex:
    def __init__(self, notes: list[Note]):
        self.notes = {n.slug: n for n in notes}
        self._titles: dict[str, list[str]] = defaultdict(list)
        self._loose: dict[str, list[str]] = defaultdict(list)
        for n in notes:
            self._add_titles(n)
        self._links: dict[str, list[str]] = {}
        self._back: dict[str, set[str]] = defaultdict(set)
        self.unresolved: dict[str, list[str]] = {}
        self.ambiguous: dict[str, list[str]] = {}  # link text -> candidate slugs
        self._ambiguous_by_note: dict[str, dict[str, list[str]]] = {}
        for n in notes:
            self._link(n)

    # -- incremental update ----------------------------------------------
    def updated(self, changed: Iterable[Note], removed: Iterable[str] = ()) -> "NoteIndex":
        """A new index equal to ``NoteIndex(all notes)`` after ``changed`` notes were added or edited and the ``removed``
        slugs deleted. This index is left untouched (readers may be iterating it). Links are only re-read for the changed
        notes, unless a title appeared, went or changed: every link is resolved through titles, so then they all are."""
        changed = {n.slug: n for n in changed}
        removed = set(removed) - set(changed)
        new = object.__new__(NoteIndex)
        new._titles = defaultdict(list, {k: list(v) for k, v in self._titles.items()})
        new._loose = defaultdict(list, {k: list(v) for k, v in self._loose.items()})
        new._links = dict(self._links)
        new._back = defaultdict(set, {k: set(v) for k, v in self._back.items()})
        new.unresolved = dict(self.unresolved)
        new.ambiguous = {}  # rebuilt from the per-note records below
        new._ambiguous_by_note = dict(self._ambiguous_by_note)
        notes = dict(self.notes)

        titles_moved = False
        for slug in removed | changed.keys():
            old = notes.pop(slug, None)
            if old is not None:
                new._drop_titles(old)
            if slug in removed or old is None or old.title != changed[slug].title:
                titles_moved = True
            if slug in removed:
                new._unlink(slug)
        for note in changed.values():
            notes[note.slug] = note
            new._add_titles(note)
        # same order as a fresh build, which lists files by name
        new.notes = dict(sorted(notes.items(), key=lambda kv: f"{kv[0]}.md"))

        if titles_moved:
            for slug in list(new._links):
                new._unlink(slug)
            relink = list(new.notes.values())
        else:
            relink = list(changed.values())
            for note in relink:
                new._unlink(note.slug)
        for note in relink:
            new._link(note)
        new.ambiguous = {k: v for amb in new._ambiguous_by_note.values() for k, v in amb.items()}
        return new

    def _add_titles(self, n: Note) -> None:
        self._titles[n.title.casefold()].append(n.slug)
        self._loose[_norm(n.title)].append(n.slug)

    def _drop_titles(self, n: Note) -> None:
        for table, key in ((self._titles, n.title.casefold()), (self._loose, _norm(n.title))):
            table[key].remove(n.slug)
            if not table[key]:
                del table[key]

    def _unlink(self, slug: str) -> None:
        for target in self._links.pop(slug, ()):
            if target != slug and target in self._back:
                self._back[target].discard(slug)
                if not self._back[target]:
                    del self._back[target]
        self.unresolved.pop(slug, None)
        self._ambiguous_by_note.pop(slug, None)

    def _link(self, n: Note) -> None:
        resolved, missing, ambiguous = [], [], {}
        for target in extract_targets(n.content):
            if target.startswith("#"):  # same-note heading anchor
                continue
            slug, candidates = self._lookup(target)
            if candidates:
                ambiguous[target.split("#", 1)[0].strip()] = candidates
            if slug:
                resolved.append(slug)
                if slug != n.slug:
                    self._back[slug].add(n.slug)
            else:
                missing.append(target)
        self._links[n.slug] = resolved
        if missing:
            self.unresolved[n.slug] = missing
        if ambiguous:
            self._ambiguous_by_note[n.slug] = ambiguous
            self.ambiguous.update(ambiguous)

    def _lookup(self, target: str) -> tuple[str | None, list[str] | None]:
        """The slug a link resolves to and, when several notes share the title, their slugs."""
        target = target.split("#", 1)[0].strip()
        if target in self.notes:
            return target, None
        for table, key in ((self._titles, target.casefold()), (self._loose, _norm(target))):
            candidates = sorted(table.get(key, []))
            if candidates:
                return candidates[0], candidates if len(candidates) > 1 else None
        return None, None

    def resolve(self, target: str) -> str | None:
        """Slug, then exact title, then punctuation-insensitive title. A ``#heading`` suffix is
        ignored. Ambiguous titles resolve to the alphabetically first slug and are recorded in
        ``ambiguous``."""
        slug, candidates = self._lookup(target)
        if candidates:
            self.ambiguous[target.split("#", 1)[0].strip()] = candidates
        return slug

    def links_from(self, slug: str) -> list[str]:
        return list(dict.fromkeys(self._links.get(slug, [])))

    def backlinks(self, slug: str) -> list[Note]:
        return sorted((self.notes[s] for s in self._back.get(slug, ())), key=lambda n: (n.title.casefold(), n.slug))

    def tags(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for n in self.notes.values():
            for t in n.tags:
                counts[t] += 1
        return dict(sorted(counts.items()))

    def types(self) -> dict[str, int]:
        """How many notes use each type (a note with several types counts once for each)."""
        counts: dict[str, int] = defaultdict(int)
        for n in self.notes.values():
            for t in n.types:
                counts[t] += 1
        return dict(sorted(counts.items()))

    def search(self, query: str, tag: str | None = None, limit: int = 50) -> list[SearchHit]:
        words = query.casefold().split()
        hits = []
        for n in self.notes.values():
            if tag and tag not in n.tags:
                continue
            score = 0 if words else 1
            title, body = n.title.casefold(), n.content.casefold()
            ok = True
            for w in words:
                s = 0
                if title == w: s += 100
                elif title.startswith(w): s += 50
                elif w in title: s += 30
                if any(w == t.casefold() for t in n.tags): s += 20
                if w in body: s += 5
                if s == 0:
                    ok = False
                    break
                score += s
            if ok:
                hits.append(SearchHit(n, score))
        hits.sort(key=lambda h: (-h.score, h.note.title.casefold()))
        return hits[:limit]

"""In-memory, rebuildable index over notes: link resolution, backlinks, tags, search."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

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
            self._titles[n.title.casefold()].append(n.slug)
            self._loose[_norm(n.title)].append(n.slug)
        self._links: dict[str, list[str]] = {}
        self._back: dict[str, set[str]] = defaultdict(set)
        self.unresolved: dict[str, list[str]] = {}
        self.ambiguous: dict[str, list[str]] = {}  # link text -> candidate slugs
        for n in notes:
            resolved, missing = [], []
            for target in extract_targets(n.content):
                if target.startswith("#"):  # same-note heading anchor
                    continue
                slug = self.resolve(target)
                if slug:
                    resolved.append(slug)
                    if slug != n.slug:
                        self._back[slug].add(n.slug)
                else:
                    missing.append(target)
            self._links[n.slug] = resolved
            if missing:
                self.unresolved[n.slug] = missing

    def resolve(self, target: str) -> str | None:
        """Slug, then exact title, then punctuation-insensitive title. A ``#heading`` suffix is
        ignored. Ambiguous titles resolve to the alphabetically first slug and are recorded in
        ``ambiguous``."""
        target = target.split("#", 1)[0].strip()
        if target in self.notes:
            return target
        for table, key in ((self._titles, target.casefold()), (self._loose, _norm(target))):
            candidates = sorted(table.get(key, []))
            if len(candidates) > 1:
                self.ambiguous[target] = candidates
            if candidates:
                return candidates[0]
        return None

    def links_from(self, slug: str) -> list[str]:
        return list(dict.fromkeys(self._links.get(slug, [])))

    def backlinks(self, slug: str) -> list[Note]:
        return sorted((self.notes[s] for s in self._back.get(slug, ())), key=lambda n: n.title.casefold())

    def tags(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for n in self.notes.values():
            for t in n.tags:
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

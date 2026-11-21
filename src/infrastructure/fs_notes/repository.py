"""NoteRepository over a git working tree of markdown files."""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from ruamel.yaml.comments import CommentedMap, CommentedSeq

from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.errors import NoteExists, NoteNotFound
from src.domain.notes.repositories import NoteRepository
from src.domain.notes.slug import validate_slug
from src.domain.notes.time import parse_day, parse_time, valid_minutes
from src.infrastructure.fs_notes import frontmatter
from src.infrastructure.git.client import GitClient

MANAGED = ("title", "tags", "created", "updated", "type", "status", "week", "time")


def _day(value: Any) -> str | None:
    return None if value is None else str(value)


def parse_types(raw: Any) -> tuple[str, ...]:
    """`type:` may be a list (the usual form) or a single scalar; blanks are dropped."""
    if raw is None:
        return ()
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    return tuple(t for t in (str(i).strip() for i in items) if t)


def parse_tags(raw: Any) -> tuple[str, ...]:
    """`tags:` may be a list (block or inline) or a single scalar."""
    if raw is None:
        return ()
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    return tuple(str(i) for i in items)


def _inline(items) -> CommentedSeq:
    """A list written inline, `[a, b]`: the vault's convention for `tags` and `type`."""
    seq = CommentedSeq(list(items))
    seq.fa.set_flow_style()
    return seq


def _types_value(types):
    """`type: task` for one type (the vault's convention), `type: [a, b]` for several."""
    return types[0] if len(types) == 1 else _inline(types)


def _time_value(time: dict[str, int], existing: Any) -> CommentedMap:
    """`time: {2026-11-20: 90, 2026-11-21: 45}`, written inline with the days as YAML dates, oldest first. Entries
    already in the file that are not a valid day and minutes are kept after the valid ones, never dropped."""
    value = CommentedMap()
    value.fa.set_flow_style()
    for day, minutes in sorted(time.items()):
        value[date.fromisoformat(day)] = minutes
    for key, minutes in (existing.items() if hasattr(existing, "items") else ()):
        if parse_day(key) is None or not valid_minutes(minutes):
            value[key] = minutes
    return value


def _set_key(meta: Any, key: str, value: Any, after: tuple[str, ...]) -> None:
    """Set `key` in place, drop it when `value` is None, or insert a new one right after the first of `after` present."""
    if value is None:
        meta.pop(key, None)
    elif key in meta:
        meta[key] = value
    else:
        keys = list(meta.keys())
        meta.insert(keys.index(next(k for k in after if k in keys)) + 1, key, value)


def _as_date(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return value


class FileNoteRepository(NoteRepository):
    def __init__(self, root: Path, git: GitClient | None = None, today=date.today):
        self.root = Path(root).expanduser().resolve()
        self.git = git or GitClient(self.root)
        self._today = today
        # slug -> ((mtime_ns, size), parsed note): `list()` only re-parses files whose stat changed.
        self._parsed: dict[str, tuple[tuple[int, int], Note]] = {}

    # -- helpers ---------------------------------------------------------
    def _rel(self, slug: str) -> str:
        return f"{validate_slug(slug)}.md"

    def _path(self, slug: str) -> Path:
        return self.root / self._rel(slug)

    def _parse(self, slug: str, text: str, modified: float | None = None) -> Note:
        meta, body = frontmatter.split(text)
        meta = meta or {}
        return Note(
            slug=slug,
            title=str(meta.get("title") or slug),
            content=body,
            tags=parse_tags(meta.get("tags")),
            created=_day(meta.get("created")),
            updated=_day(meta.get("updated")),
            types=parse_types(meta.get("type")),
            status=(str(meta["status"]).strip() or None) if meta.get("status") is not None else None,
            week=(str(meta["week"]).strip() or None) if meta.get("week") is not None else None,
            time=parse_time(meta.get("time")),
            extra={k: v for k, v in meta.items() if k not in MANAGED},
            modified=modified,
        )

    def _write(self, note: Note, existing_text: str | None) -> None:
        meta, _ = frontmatter.split(existing_text) if existing_text else (None, "")
        if meta is None:
            meta = frontmatter.new_map()
        iso = self._today().isoformat()  # fresh date objects per key: shared ones become YAML anchors
        meta["title"] = note.title
        # `tags`, `type`, `status`, `week` and `time` are only touched when they changed, so a file keeps its own list
        # style (inline, block or scalar); a value that does change is written inline, as in the rest of the vault.
        # A new key goes right after the nearest key before it in the vault's order, not at the end.
        if tuple(note.tags) != parse_tags(meta.get("tags")):
            _set_key(meta, "tags", _inline(note.tags), ("title",))
        if "created" not in meta:
            meta["created"] = _as_date(note.created or iso)
        meta["updated"] = _as_date(iso)
        if tuple(note.types) != parse_types(meta.get("type")):
            _set_key(meta, "type", _types_value(note.types) if note.types else None, ("tags", "title"))
        current_status = str(meta["status"]).strip() if meta.get("status") is not None else None
        if note.status != (current_status or None):
            _set_key(meta, "status", note.status, ("type", "tags", "title"))
        current_week = str(meta["week"]).strip() if meta.get("week") is not None else None
        if note.week != (current_week or None):
            _set_key(meta, "week", note.week, ("status", "type", "tags", "title"))
        if note.time != parse_time(meta.get("time")):  # only when the usable days changed
            _set_key(meta, "time", _time_value(note.time, meta.get("time")) or None, ("week", "status", "type", "tags", "title"))
        for k in [k for k in meta if k not in MANAGED and k not in note.extra]:
            del meta[k]  # an unmanaged key the note no longer has (a cleared property)
        for k, v in note.extra.items():
            if k not in meta or meta[k] != v:  # an unchanged value keeps its own quoting and style
                meta[k] = v
        self._path(note.slug).write_text(frontmatter.render(meta, note.content), encoding="utf-8")

    def _commit(self, paths: list[str], message: str) -> None:
        self.git.commit_paths(paths, message)

    # -- queries ---------------------------------------------------------
    def list(self) -> list[Note]:
        """Every note, by file name. Parsing is the cost, so a file whose (mtime, size) is unchanged since the last call
        reuses its parsed note; the stat comes before the read, so a write in between is only ever picked up late."""
        cache, notes = self._parsed, []
        fresh: dict[str, tuple[tuple[int, int], Note]] = {}
        for path in sorted(self.root.glob("*.md")):
            try:
                st = path.stat()
                key = (st.st_mtime_ns, st.st_size)
                hit = cache.get(path.stem)
                if hit and hit[0] == key:
                    note = hit[1]
                else:
                    note = self._parse(path.stem, path.read_text(encoding="utf-8"), st.st_mtime)
            except FileNotFoundError:  # deleted while listing
                continue
            fresh[path.stem] = (key, note)
            notes.append(note)
        self._parsed = fresh
        return notes

    def get(self, slug: str) -> Note:
        path = self._path(slug)
        if not path.is_file():
            raise NoteNotFound(slug)
        return self._parse(slug, path.read_text(encoding="utf-8"), path.stat().st_mtime)

    # -- commands (each is one commit) -----------------------------------
    def create(self, note: Note) -> Note:
        with self.git.lock:
            if self._path(note.slug).exists():
                raise NoteExists(note.slug)
            self._write(note, None)
            self._commit([self._rel(note.slug)], f"doc: add {note.title}")
            return self.get(note.slug)

    def update(self, note: Note) -> Note:
        with self.git.lock:
            path = self._path(note.slug)
            if not path.is_file():
                raise NoteNotFound(note.slug)
            self._write(note, path.read_text(encoding="utf-8"))
            self._commit([self._rel(note.slug)], f"doc: update {note.title}")
            return self.get(note.slug)

    def update_many(self, notes: list[Note], message: str) -> list[Note]:
        with self.git.lock:
            paths = [self._path(n.slug) for n in notes]
            for note, path in zip(notes, paths):
                if not path.is_file():
                    raise NoteNotFound(note.slug)
            for note, path in zip(notes, paths):
                self._write(note, path.read_text(encoding="utf-8"))
            self._commit([self._rel(n.slug) for n in notes], message)
            return [self.get(n.slug) for n in notes]

    def rename(self, slug: str, new_slug: str) -> Note:
        with self.git.lock:
            if not self._path(slug).is_file():
                raise NoteNotFound(slug)
            if self._path(new_slug).exists():
                raise NoteExists(new_slug)
            self.git.mv(self._rel(slug), self._rel(new_slug))
            self._commit([self._rel(slug), self._rel(new_slug)], f"doc: rename {slug} to {new_slug}")
            return self.get(new_slug)

    def delete(self, slug: str) -> None:
        with self.git.lock:
            path = self._path(slug)
            if not path.is_file():
                raise NoteNotFound(slug)
            title = self._parse(slug, path.read_text(encoding="utf-8")).title
            path.unlink()
            self._commit([self._rel(slug)], f"doc: delete {title}")

    # -- history ---------------------------------------------------------
    def versions(self, slug: str) -> list[NoteVersion]:
        self._rel(slug)
        return [
            NoteVersion(c.sha, c.message, c.author, c.committed_at, c.path)
            for c in self.git.log(self._rel(slug))
        ]

    def _version_text(self, slug: str, sha: str) -> str:
        match = next((v for v in self.versions(slug) if v.sha == sha or v.sha.startswith(sha)), None)
        if match is None:
            raise NoteNotFound(f"{slug}@{sha}")
        return self.git.show(match.sha, match.path)

    def get_version(self, slug: str, sha: str) -> Note:
        return self._parse(slug, self._version_text(slug, sha))

    def restore(self, slug: str, sha: str) -> Note:
        """Write an old version back as a *new* commit; history is never rewritten."""
        with self.git.lock:
            old = self._version_text(slug, sha)
            self._path(slug).write_text(old, encoding="utf-8")
            title = self._parse(slug, old).title
            self._commit([self._rel(slug)], f"doc: restore {title} to {sha[:7]}")
            return self.get(slug)

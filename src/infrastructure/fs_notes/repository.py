"""NoteRepository over a git working tree of markdown files."""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from src.domain.notes.entities import Note, NoteVersion
from src.domain.notes.errors import NoteExists, NoteNotFound
from src.domain.notes.repositories import NoteRepository
from src.domain.notes.slug import validate_slug
from src.infrastructure.fs_notes import frontmatter
from src.infrastructure.git.client import GitClient

MANAGED = ("title", "tags", "created", "updated")


def _day(value: Any) -> str | None:
    return None if value is None else str(value)


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

    # -- helpers ---------------------------------------------------------
    def _rel(self, slug: str) -> str:
        return f"{validate_slug(slug)}.md"

    def _path(self, slug: str) -> Path:
        return self.root / self._rel(slug)

    def _parse(self, slug: str, text: str, modified: float | None = None) -> Note:
        meta, body = frontmatter.split(text)
        meta = meta or {}
        tags = meta.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        return Note(
            slug=slug,
            title=str(meta.get("title") or slug),
            content=body,
            tags=tuple(str(t) for t in tags),
            created=_day(meta.get("created")),
            updated=_day(meta.get("updated")),
            extra={k: v for k, v in meta.items() if k not in MANAGED},
            modified=modified,
        )

    def _write(self, note: Note, existing_text: str | None) -> None:
        meta, _ = frontmatter.split(existing_text) if existing_text else (None, "")
        if meta is None:
            meta = frontmatter.new_map()
        iso = self._today().isoformat()  # fresh date objects per key: shared ones become YAML anchors
        meta["title"] = note.title
        if note.tags or "tags" in meta:
            meta["tags"] = list(note.tags)
        if "created" not in meta:
            meta["created"] = _as_date(note.created or iso)
        meta["updated"] = _as_date(iso)
        for k, v in note.extra.items():
            meta[k] = v
        self._path(note.slug).write_text(frontmatter.render(meta, note.content), encoding="utf-8")

    def _commit(self, paths: list[str], message: str) -> None:
        self.git.commit_paths(paths, message)

    # -- queries ---------------------------------------------------------
    def list(self) -> list[Note]:
        return [self._parse(p.stem, p.read_text(encoding="utf-8"), p.stat().st_mtime) for p in sorted(self.root.glob("*.md"))]

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

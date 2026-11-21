"""Ports for note storage and versioning."""
from __future__ import annotations

from abc import ABC, abstractmethod

from src.domain.notes.entities import Comparison, Note, NoteVersion


class NoteRepository(ABC):
    @abstractmethod
    def list(self) -> list[Note]: ...

    @abstractmethod
    def get(self, slug: str) -> Note: ...

    @abstractmethod
    def create(self, note: Note) -> Note: ...

    @abstractmethod
    def update(self, note: Note) -> Note: ...

    @abstractmethod
    def update_many(self, notes: list[Note], message: str) -> list[Note]:
        """Update several notes in one commit."""

    @abstractmethod
    def rename(self, slug: str, new_slug: str) -> Note: ...

    @abstractmethod
    def delete(self, slug: str) -> None: ...

    @abstractmethod
    def versions(self, slug: str, limit: int | None = None, offset: int = 0) -> list[NoteVersion]:
        """Newest first; `limit` and `offset` pick one page."""

    @abstractmethod
    def get_version(self, slug: str, sha: str) -> Note: ...

    @abstractmethod
    def version_changes(self, slug: str, limit: int | None = None, offset: int = 0) -> list[NoteVersion]:
        """Like `versions`, with each version's kind and summary filled in."""

    @abstractmethod
    def compare(self, slug: str, sha: str, against: str) -> Comparison:
        """A version against its previous version (`previous`) or the current note (`current`)."""

    @abstractmethod
    def restore(self, slug: str, sha: str) -> Note: ...

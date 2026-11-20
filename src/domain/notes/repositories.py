"""Ports for note storage and versioning."""
from __future__ import annotations

from abc import ABC, abstractmethod

from src.domain.notes.entities import Note, NoteVersion


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
    def rename(self, slug: str, new_slug: str) -> Note: ...

    @abstractmethod
    def delete(self, slug: str) -> None: ...

    @abstractmethod
    def versions(self, slug: str) -> list[NoteVersion]: ...

    @abstractmethod
    def get_version(self, slug: str, sha: str) -> Note: ...

    @abstractmethod
    def restore(self, slug: str, sha: str) -> Note: ...

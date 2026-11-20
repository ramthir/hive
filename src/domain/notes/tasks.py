"""Task notes: a note of type `task` is a card on the task board."""
from __future__ import annotations

from datetime import date
from typing import Literal, get_args

from src.domain.notes.entities import Note

WEEK_PATTERN = r"^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$"


def week_label(day: date) -> str:
    """The ISO 8601 week of a day, as written in `week:` (2026-11-20 -> 2026-W47)."""
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


TaskStatus = Literal["TODO", "IN_PROGRESS", "DONE"]
STATUSES: tuple[str, ...] = get_args(TaskStatus)


def is_task(note: Note) -> bool:
    return any(t.casefold() == "task" for t in note.types)


def task_status(note: Note) -> str:
    """The stored `status:` if it is a known one, else DONE for a note tagged `done`, else TODO.
    (Older task notes in the vault have no status, only a `todo` / `done` tag.)"""
    stored = (note.status or "").strip().upper().replace(" ", "_").replace("-", "_")
    if stored in STATUSES:
        return stored
    return "DONE" if any(t.casefold() == "done" for t in note.tags) else "TODO"

"""Task notes: a note of type `task` is a card on the task board."""
from __future__ import annotations

from datetime import date
import re
from typing import Literal, get_args

from src.domain.notes.entities import Note

WEEK_PATTERN = r"^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$"


def week_label(day: date) -> str:
    """The ISO 8601 week of a day, as written in `week:` (2026-11-20 -> 2026-W47)."""
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


# "1 Must / 2 Important / 3 Nice to have": a task's priority is marked with one of these tags, most urgent first.
TaskPriority = Literal["must", "important", "nice-to-have"]
PRIORITIES: tuple[str, ...] = get_args(TaskPriority)

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


def task_week(note: Note) -> tuple[str | None, bool]:
    """The week a task belongs to and whether it was recorded: the stored `week:` if valid, else the week of the
    `updated` day (False), else None. The Done column filters and the card's week chip both use this."""
    if note.week and re.match(WEEK_PATTERN, note.week):
        return note.week, True
    try:
        return week_label(date.fromisoformat((note.updated or "")[:10])), False
    except ValueError:
        return None, False


def _tag_name(tag: str) -> str:
    return tag.strip().lstrip("#").casefold()


def task_priority(tags: tuple[str, ...] | list[str]) -> str | None:
    """The most urgent priority among the tags (`#must` beats `#important`), or None."""
    names = {_tag_name(t) for t in tags}
    return next((p for p in PRIORITIES if p in names), None)


def without_priority(tags: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    return tuple(t for t in tags if _tag_name(t) not in PRIORITIES)


def with_priority(tags: tuple[str, ...] | list[str], priority: str | None) -> tuple[str, ...]:
    """The tags with their priority tag(s) replaced by `priority` (None: no priority tag at all)."""
    return without_priority(tags) + ((priority,) if priority else ())

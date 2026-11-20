"""Time logged on task and meeting notes: the `time:` frontmatter key maps an ISO day to the minutes spent."""
from __future__ import annotations

from datetime import date
from typing import Any

from src.domain.notes.entities import Note

MAX_MINUTES_PER_DAY = 24 * 60
TIME_TYPES = ("task", "meeting")


def accepts_time(note: Note) -> bool:
    """Only a note of type `task` or `meeting` takes logged time."""
    return any(t.casefold() in TIME_TYPES for t in note.types)


def time_type(note: Note) -> str | None:
    """`task` or `meeting` (a note that is both counts as a task), or None."""
    kinds = {t.casefold() for t in note.types}
    return next((k for k in TIME_TYPES if k in kinds), None)


def parse_day(raw: Any) -> str | None:
    """A frontmatter key or API value as an ISO day (`2026-11-20`), or None if it is not a real date."""
    try:
        return date.fromisoformat(str(raw)).isoformat()
    except ValueError:
        return None


def valid_minutes(raw: Any) -> bool:
    return type(raw) is int and 1 <= raw <= MAX_MINUTES_PER_DAY


def parse_time(raw: Any) -> dict[str, int]:
    """The usable days of a `time:` value, oldest first. Anything else (a bad date, 0 or too many minutes, a
    non-number, a value that is not a map) is ignored here; the repository leaves such entries in the file."""
    if not hasattr(raw, "items"):
        return {}
    days = {}
    for key, minutes in raw.items():
        day = parse_day(key)
        if day is not None and valid_minutes(minutes):
            days[day] = minutes
    return dict(sorted(days.items()))

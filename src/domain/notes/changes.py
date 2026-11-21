"""What a commit did to a note, in words: the kind (for the icon and the filters) and a one-line summary.

Pure: it compares two parsed notes, the one a commit left and the one before it."""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from datetime import date

from src.domain.notes.entities import Note
from src.domain.notes.tasks import task_priority

KINDS = ("text", "properties", "time", "restore", "rename", "created", "saved")
STATUS_LABELS = {"TODO": "To do", "IN_PROGRESS": "In progress", "DONE": "Done"}
_RESTORE = re.compile(r"^doc: restore .* to (\w+)$")
_HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")
_MAX_PARTS = 2


@dataclass(frozen=True)
class Change:
    kind: str  # the main one, for the icon: one of KINDS
    kinds: tuple[str, ...]  # every kind present, for the filters
    summary: str  # "Moved to Done, edited text"
    detail: str = ""  # a grey tail: the section edited, the day logged


def duration(minutes: int) -> str:
    hours, rest = divmod(abs(minutes), 60)
    return " ".join(part for part in (f"{hours}h" if hours else "", f"{rest}m" if rest or not hours else "") if part)


def day_label(day: str) -> str:
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return day
    return f"{d.day} {d:%b}"


def _section(old: str, new: Note) -> str:
    """The heading above the first line that changed, unless it is the note's own title."""
    old_lines, new_lines = old.splitlines(), new.content.splitlines()
    for tag, _, _, j1, _ in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        for i in range(min(j1, len(new_lines) - 1), -1, -1):
            match = _HEADING.match(new_lines[i])
            if match:
                return "" if match.group(1) == new.title else match.group(1)
        return ""
    return ""


def _time_part(old: dict[str, int], new: dict[str, int]) -> tuple[str, str]:
    days = sorted(day for day in set(old) | set(new) if old.get(day) != new.get(day))
    if len(days) != 1:
        return f"updated time on {len(days)} days", ""
    day = days[0]
    before, after = old.get(day, 0), new.get(day, 0)
    if not after:
        return "removed time", day_label(day)
    return (f"logged {duration(after - before)}" if after > before else f"changed time to {duration(after)}"), day_label(day)


def _property_parts(old: Note, new: Note) -> list[str]:
    parts = []
    if (old.status or "") != (new.status or ""):
        label = STATUS_LABELS.get(new.status or "", new.status)
        parts.append(f"moved to {label}" if new.status else "cleared the status")
    if task_priority(old.tags) != task_priority(new.tags):
        parts.append(f"set priority to {task_priority(new.tags)}" if task_priority(new.tags) else "removed the priority")
    other_old, other_new = {t for t in old.tags if t != task_priority(old.tags)}, {t for t in new.tags if t != task_priority(new.tags)}
    added, removed = sorted(other_new - other_old), sorted(other_old - other_new)
    if added or removed:
        parts.append(f"added {', '.join(added)}" if added and not removed else f"removed {', '.join(removed)}" if removed and not added else "changed the tags")
    if tuple(old.types) != tuple(new.types):
        parts.append("changed the type")
    if (old.week or "") != (new.week or "") and not (new.status and "moved to" in " ".join(parts)):
        parts.append(f"set week {new.week}" if new.week else "cleared the week")
    keys = sorted(k for k in set(old.extra) | set(new.extra) if old.extra.get(k) != new.extra.get(k))
    if keys:
        parts.append(f"changed {keys[0]}" if len(keys) == 1 else f"changed {len(keys)} properties")
    return parts


def describe(old: Note | None, new: Note, message: str = "", old_path: str = "", new_path: str = "") -> Change:
    """`old` is the note as the previous commit left it (None for the first one)."""
    if old is None:
        return Change("created", ("created",), "Created the note")
    restored = _RESTORE.match(message)
    if restored:
        return Change("restore", ("restore",), "Restored an earlier version", restored.group(1))

    kinds: list[str] = []
    parts: list[str] = []
    detail = ""
    renamed = bool(old_path and new_path and old_path != new_path)
    if renamed:
        kinds.append("rename")
        parts.append(f"renamed to {new.title}")
    if old.content != new.content:
        kinds.append("text")
        parts.append("edited text")
        detail = _section(old.content, new)
    if old.time != new.time:
        kinds.append("time")
        part, day = _time_part(old.time, new.time)
        parts.append(part)
        detail = detail or day
    props = _property_parts(old, new)
    if props:
        kinds.append("properties")
        parts[:0] = props
    if old.title != new.title and not renamed and "text" not in kinds:
        parts.append(f"retitled to {new.title}")
    if not parts:
        return Change("saved", ("saved",), "Saved", "no visible change")

    shown = parts[:_MAX_PARTS] + ([f"+{len(parts) - _MAX_PARTS} more"] if len(parts) > _MAX_PARTS else [])
    summary = ", ".join(shown)
    kind = "rename" if kinds == ["rename"] else next(k for k in ("text", "time", "properties", "rename") if k in kinds)
    return Change(kind, tuple(kinds), summary[0].upper() + summary[1:], detail)


@dataclass(frozen=True)
class PropertyChange:
    key: str
    old: str | None  # None: the key was not there
    new: str | None  # None: the key is gone
    minor: bool = False  # bookkeeping (`updated`), shown dimmed


def _time_text(time: dict[str, int]) -> str | None:
    return ", ".join(f"{day_label(day)} {duration(minutes)}" for day, minutes in time.items()) or None


def _fields(note: Note | None) -> dict[str, str | None]:
    if note is None:
        return {}
    fields: dict[str, str | None] = {
        "status": note.status, "week": note.week, "type": ", ".join(note.types) or None,
        "tags": ", ".join(note.tags) or None, "time": _time_text(note.time),
        "updated": str(note.updated) if note.updated else None,
    }
    fields.update({key: str(value) for key, value in note.extra.items() if value not in (None, "")})
    return fields


def property_changes(old: Note | None, new: Note) -> list[PropertyChange]:
    """The frontmatter keys that differ between two versions, in a stable order (bookkeeping last)."""
    before, after = _fields(old), _fields(new)
    keys = [k for k in {**after, **before} if before.get(k) != after.get(k)]
    keys.sort(key=lambda k: (k == "updated", k))
    return [PropertyChange(k, before.get(k), after.get(k), minor=k == "updated") for k in keys]

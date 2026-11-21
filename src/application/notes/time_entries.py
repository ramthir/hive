"""Logged time as rows (one note on one day), with the search syntax and the month summary of the time page."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Iterable

from src.domain.notes.entities import Note
from src.domain.notes.tasks import week_label
from src.domain.notes.time import accepts_time, time_type


@dataclass(frozen=True)
class TimeRow:
    slug: str
    title: str
    type: str  # "task" or "meeting"
    project: str  # the note's optional `project:` frontmatter, else ""
    day: str  # ISO day
    minutes: int

    @property
    def id(self) -> str:
        return f"{self.slug}:{self.day}"


def rows_of(note: Note) -> list[TimeRow]:
    kind = time_type(note)
    if kind is None:
        return []
    project = str(note.extra.get("project") or "").strip()
    return [TimeRow(note.slug, note.title, kind, project, day, minutes) for day, minutes in note.time.items()]


_FILTER = re.compile(
    r"\b(project|task|date|duration)\s*:\s*(\"[^\"]+\"(?=\s|$)|'[^']+'(?=\s|$)|.*?(?=\s+\b(?:project|task|date|duration)\s*:|$))",
    re.IGNORECASE)
_AMOUNT = r"(\d+(?:\.\d+)?)(m|h)?"


def parse_query(query: str) -> tuple[str, dict[str, str]]:
    """Split `fix login project:Acme date:today duration:>30m` into the free text and its filters."""
    filters: dict[str, str] = {}
    text: list[str] = []
    cursor = 0
    for m in _FILTER.finditer(query):
        text.append(query[cursor:m.start()])
        filters[m.group(1).lower()] = m.group(2).strip().strip("\"'")
        cursor = m.end()
    text.append(query[cursor:])
    return " ".join(" ".join(text).split()), filters


def _minutes(value: str, unit: str | None) -> float:
    return float(value) * (60 if (unit or "m").lower() == "h" else 1)


def _duration_test(spec: str):
    """`>30m`, `<=2h`, `45` (exactly 45 minutes) or a range `30m-2h`; None when it makes no sense."""
    spec = spec.replace(" ", "")
    rng = re.fullmatch(f"{_AMOUNT}-{_AMOUNT}", spec, re.IGNORECASE)
    if rng:
        low, high = _minutes(*rng.group(1, 2)), _minutes(*rng.group(3, 4))
        return lambda m: low <= m <= high
    cmp = re.fullmatch(rf"(>=|<=|>|<|=)?{_AMOUNT}", spec, re.IGNORECASE)
    if cmp:
        limit = _minutes(*cmp.group(2, 3))
        return {">=": lambda m: m >= limit, "<=": lambda m: m <= limit, ">": lambda m: m > limit,
                "<": lambda m: m < limit}.get(cmp.group(1) or "=", lambda m: m == limit)
    return None


def _day_of(spec: str, today: date) -> str | None:
    spec = spec.lower()
    if spec in ("today", "yesterday"):
        return (today - timedelta(days=spec == "yesterday")).isoformat()
    try:
        return date.fromisoformat(spec).isoformat()
    except ValueError:
        return None


def select(rows: Iterable[TimeRow], *, query: str = "", start: str | None = None, end: str | None = None,
           slug: str | None = None, today: date) -> list[TimeRow]:
    """The rows matching the search and the date range, newest day first, then by title."""
    text, filters = parse_query(query)
    text = text.casefold()
    task = filters.get("task", "").casefold()
    project = filters.get("project", "").casefold()
    day = _day_of(filters["date"], today) if filters.get("date") else None
    duration = _duration_test(filters["duration"]) if filters.get("duration") else None
    if filters.get("duration") and duration is None:  # like an unreadable date: matches nothing
        return []
    out = []
    for r in rows:
        if slug and r.slug != slug:
            continue
        if start and r.day < start or end and r.day > end:
            continue
        if text and text not in r.title.casefold():
            continue
        if task and task not in r.title.casefold():
            continue
        if project and project not in r.project.casefold():
            continue
        if filters.get("date") and r.day != day:  # an unreadable date matches nothing
            continue
        if duration and not duration(r.minutes):
            continue
        out.append(r)
    out.sort(key=lambda r: r.title.casefold())
    return sorted(out, key=lambda r: r.day, reverse=True)  # stable: titles stay A-Z within a day


def _in_week(day: str, week: str) -> bool:
    try:
        return week_label(date.fromisoformat(day[:10])) == week
    except ValueError:
        return False


def order_time_notes(notes: Iterable[Note], week: str) -> list[tuple[Note, bool]]:
    """The notes that take time (tasks and meetings) with whether they are `week`'s: edited that week or with time
    logged in it. That week's come first, most recently edited first; the rest follow by title."""
    flagged = [(n, _in_week(n.updated or "", week) or any(_in_week(d, week) for d in n.time))
               for n in sorted((n for n in notes if accepts_time(n)), key=lambda n: n.title.casefold())]
    recent = sorted((f for f in flagged if f[1]), key=lambda f: (f[0].updated or "", f[0].modified or 0.0), reverse=True)
    return recent + [f for f in flagged if not f[1]]


def month_summary(rows: Iterable[TimeRow], today: date) -> dict[str, Any]:
    """The current month of the matched rows: entries and minutes in total and for tasks and meetings, today's
    minutes, and per day (days with time only, oldest first) the minutes and what they were spent on."""
    month = today.isoformat()[:7]
    mine = [r for r in rows if r.day[:7] == month]
    by = lambda kind: sum(r.minutes for r in mine if r.type == kind)
    days: dict[str, list[TimeRow]] = {}
    for r in sorted(mine, key=lambda r: (r.day, r.title.casefold())):
        days.setdefault(r.day, []).append(r)
    return {
        "month": month, "today": today.isoformat(),
        "today_minutes": sum(r.minutes for r in mine if r.day == today.isoformat()),
        "total_entries": len(mine), "total_minutes": sum(r.minutes for r in mine),
        "task_minutes": by("task"), "meeting_minutes": by("meeting"),
        "days": [{"day": day, "minutes": sum(r.minutes for r in items),
                  "items": [{"title": r.title, "project": r.project, "minutes": r.minutes} for r in items]}
                 for day, items in days.items()],
    }

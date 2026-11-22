"""The properties drawer of a note: its type's form with the note's values and the choices for each field."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

from src.domain.notes.entities import Note
from src.domain.notes.properties import Field, Form, extra_values, split_titles
from src.domain.notes.tasks import task_priority, task_status, week_label, without_priority

WEEKS_BEFORE, WEEKS_AFTER = 2, 2


def week_choices(today: date, stored: str | None) -> list[tuple[str, str]]:
    """Two weeks either side of this one, newest first, plus the note's own week when it is further away."""
    weeks = [week_label(today + timedelta(weeks=n)) for n in range(WEEKS_AFTER, -WEEKS_BEFORE - 1, -1)]
    if stored and stored not in weeks:
        weeks.append(stored)
    return [(w, w) for w in weeks]


def _note_choices(field: Field, notes: Iterable[Note], me: str, current: str) -> list[tuple[str, str]]:
    wanted = {t.casefold() for t in field.note_types}
    titles = sorted({n.title for n in notes if n.slug != me and wanted & {t.casefold() for t in n.types}},
                    key=str.casefold)
    for kept in split_titles(current):  # a value typed by hand (or a note since retyped) stays selectable
        if kept not in titles:
            titles.append(kept)
    return [(t, t) for t in titles]


def _known_values(field: Field, notes: Iterable[Note], me: str, current: str) -> list[tuple[str, str]]:
    """What other notes already have for the field's key (links read as their title), plus the note's own values."""
    found = {t for n in notes if n.slug != me for t in split_titles(n.extra.get(field.key))}
    found.update(split_titles(current))
    return [(t, t) for t in sorted(found, key=str.casefold)]


def _value(field: Field, note: Note, values: dict[str, str]) -> str:
    if field.target == "tags":  # comma-separated; the priority tag of an older note is the Priority field
        return ",".join(without_priority(note.tags))
    if field.target == "status":
        return task_status(note)
    if field.target == "priority":
        return task_priority(note) or ""
    if field.target == "week":
        return note.week or ""
    return values[field.key]


def build(form: Form, note: Note, notes: Iterable[Note], today: date) -> dict:
    values = extra_values(form, note)
    fields = []
    for f in form.fields:
        value = _value(f, note, values)
        if f.kind == "note":
            choices = _note_choices(f, notes, note.slug, value)
        elif f.kind == "values":
            choices = _known_values(f, notes, note.slug, value)
        elif f.target == "week":
            choices = week_choices(today, note.week)
        else:
            choices = list(f.choices)
        fields.append({
            "key": f.key, "label": f.label, "icon": f.icon, "kind": f.kind, "target": f.target, "group": f.group,
            "placeholder": f.placeholder or f"Select {f.label.lower()}...", "required": f.required, "wide": f.wide, "multiple": f.multiple,
            "show_when": None if f.show_when is None else {"key": f.show_when[0], "value": f.show_when[1]},
            "value": value, "choices": [{"value": v, "label": label} for v, label in choices],
        })
    return {"title": f"{form.name} Properties", "groups": form.groups or {}, "fields": fields}

"""Note properties: the fields the properties drawer offers for a note of a given type.

Pandora keeps these as links between notes in a database; here they are frontmatter. A field's `target` says where
it lives: `property` is its own frontmatter key (`project: Acme`), the others are the keys the app already manages
(`tags`, `status`, `priority`, `week`) so the drawer and the task board stay in step.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from src.domain.notes.entities import Note
from src.domain.notes.errors import InvalidProperty

Kind = Literal["text", "select", "note", "values", "tags"]  # free text, `values` (the values other notes already have for the key, and new ones), one of `choices`, the title of a note of one of `note_types`, or a list of tags
Target = Literal["property", "tags", "status", "priority", "week"]
MAX_LENGTH = 255


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    icon: str
    kind: Kind = "text"
    target: Target = "property"
    group: str | None = None
    choices: tuple[tuple[str, str], ...] = ()  # (value, label) of a select
    note_types: tuple[str, ...] = ()  # the types a `note` field picks from
    show_when: tuple[str, str] | None = None  # (key, value): only shown, and only required, while that field has that value
    required: bool = False
    wide: bool = False
    placeholder: str = ""
    multiple: bool = False  # a `note` field that takes several titles: a list in the frontmatter (one title stays a plain value)


@dataclass(frozen=True)
class Form:
    name: str  # "Task": the drawer is titled "Task Properties"
    fields: tuple[Field, ...]
    groups: dict[str, str] | None = None  # group key -> heading

    def field(self, key: str) -> Field | None:
        return next((f for f in self.fields if f.key == key and f.target == "property"), None)


def _choices(*labels: str) -> tuple[tuple[str, str], ...]:
    return tuple((label, label) for label in labels)


PROJECT_TYPES = ("project", "company")  # work is booked against a client company as well as a project


def _project() -> Field:
    return Field("project", "Project", "hammer", "note", note_types=PROJECT_TYPES, placeholder="Select project...")


BILLING = ("Billable", "Non Billable")
ENGAGEMENT_BILLING = Field("billing", "Billing", "money-bill-wave", "select", choices=_choices(*BILLING, "Prospecting"),
                           placeholder="Not set")
TASK_STATUS = (("TODO", "To Do"), ("IN_PROGRESS", "In Progress"), ("DONE", "Done"))
TASK_PRIORITY = (("must", "Must"), ("important", "Important"), ("nice-to-have", "Nice to have"))

TASK = Form(
    "Task",
    groups={"context": "Project & Context", "execution": "Task Execution & Schedule", "tags": "Tags"},
    fields=(
        Field("project", "Project", "hammer", "note", group="context", note_types=PROJECT_TYPES, placeholder="Select project..."),
        Field("specification", "Specification", "certificate", "note", group="context", note_types=("spec", "specification"),
              placeholder="Select specification..."),
        Field("ticket", "Ticket ID", "ticket", group="context", placeholder="e.g. PROJ-123"),
        Field("status", "Status", "list-check", "select", target="status", group="execution", choices=TASK_STATUS),
        Field("priority", "Priority", "flag", "select", target="priority", group="execution", choices=TASK_PRIORITY,
              placeholder="None"),
        Field("assignee", "Assignee", "user", "note", group="execution", note_types=("contact",), placeholder="Select assignee..."),
        Field("week", "Week", "calendar-week", "select", target="week", group="execution", placeholder="No week"),
        Field("tags", "Tags", "tag", "tags", target="tags", group="tags", wide=True, placeholder="Add tags"),
    ),
)
SPEC = Form("Spec", fields=(_project(), Field("application", "Application", "code", "note", note_types=("application", "project"),
                                       placeholder="Select application...")))
CONTACT = Form(
    "Contact",
    groups={"context": "Project & Team"},
    fields=(
        Field("role", "Role", "id-badge", "values", multiple=True, placeholder="Select or add roles..."),
        Field("project", "Project", "hammer", "note", group="context", note_types=PROJECT_TYPES, multiple=True, wide=True,
              placeholder="Select projects..."),
        Field("team", "Team", "users", "values", group="context", multiple=True, wide=True, placeholder="Select or add teams..."),
        Field("billing", "Billing", "money-bill-wave", "select", group="context", choices=_choices(*BILLING, "Shadowed"),
              placeholder="Not set"),
        Field("acting_for", "Acting for", "user-group", "note", group="context", note_types=("contact",), required=True,
              show_when=("billing", "Shadowed"), placeholder="Select the contact being covered..."),
    ),
)

# Keyed by lower-case type. The first of a note's types (in this order) that has a form wins, so a note that is
# both a task and a meeting gets the task's.
FORMS: dict[str, Form] = {
    "task": TASK,
    "meeting": Form("Meeting", fields=(Field("week", "Week", "calendar-week", "select", target="week", placeholder="No week"), _project())),
    "project": Form("Project", fields=(ENGAGEMENT_BILLING,)),
    "company": Form("Company", fields=(ENGAGEMENT_BILLING,)),
    "contact": CONTACT,
    "spec": SPEC,
    "specification": SPEC,
    "prompt": Form("Prompt", fields=(_project(),)),
}


def form_for(types: tuple[str, ...] | list[str]) -> Form | None:
    wanted = {t.casefold() for t in types}
    return next((form for type_, form in FORMS.items() if type_ in wanted), None)


def visible(field: Field, values: dict[str, str]) -> bool:
    return field.show_when is None or values.get(field.show_when[0], "") == field.show_when[1]


_LINK = re.compile(r"^\[\[(.*?)(?:\|.*)?\]\]$")


def _linked(value: object) -> bool:
    """True when the stored value is written as wiki links (`['[[Acme]]']`, `'[[Acme]]'`), as the vault's own notes do."""
    parts = value if isinstance(value, (list, tuple)) else [value]
    return any(_LINK.match(str(v).strip()) for v in parts)


def split_titles(value: object) -> list[str]:
    """The titles in a stored or submitted value: a list, or text with commas between the titles; `[[Title]]` links
    count as their title; no blanks or repeats."""
    parts = value if isinstance(value, (list, tuple)) else str(value or "").split(",")
    seen: dict[str, None] = {}
    for part in parts:
        text = str(part).strip()
        link = _LINK.match(text)
        title = " ".join((link.group(1) if link else text).split())
        if title:
            seen.setdefault(title)
    return list(seen)


def _text(field: Field, value: object) -> str:
    if field.multiple:
        return ",".join(split_titles(value))
    return str(value or "").strip()


def extra_values(form: Form, note: Note) -> dict[str, str]:
    """The current value of each `property` field of the form, as text ("" when not set; a multiple field's titles are
    comma-separated)."""
    return {f.key: _text(f, note.extra.get(f.key)) for f in form.fields if f.target == "property"}


def apply_properties(form: Form | None, note: Note, changes: dict[str, str]) -> dict:
    """The note's `extra` after setting the given property fields ("" removes one).

    A field hidden by its `show_when` (Acting for, once Billing is no longer Shadowed) is removed too, and a visible
    required field that the change touches must have a value. Keys the form does not have are an error, so the
    drawer cannot be used to write arbitrary frontmatter."""
    extra = dict(note.extra)
    if not changes:
        return extra
    if form is None:
        raise InvalidProperty("This note's type has no properties.")
    values = extra_values(form, note)
    for key, raw in changes.items():
        field = form.field(key)
        if field is None:
            raise InvalidProperty(f"{key!r} is not a property of this note's type.")
        value = ",".join(split_titles(raw)) if field.multiple else " ".join(str(raw).split())
        if len(value) > MAX_LENGTH:
            raise InvalidProperty(f"{field.label} is longer than {MAX_LENGTH} characters.")
        if value and field.kind == "select" and value not in dict(field.choices):
            raise InvalidProperty(f"{value!r} is not a choice for {field.label}.")
        values[key] = value
    for field in form.fields:
        if field.target != "property":
            continue
        touched = field.key in changes or (field.show_when and field.show_when[0] in changes)
        if not visible(field, values):
            values[field.key] = ""
        elif touched and field.required and not values[field.key]:
            raise InvalidProperty(f"{field.label} is required.")
    for key, value in values.items():
        if value:
            field = form.field(key)
            if extra.get(key) is None or _text(field, extra[key]) != value:
                titles = value.split(",") if field.multiple else []
                if field.multiple and _linked(extra.get(key)):  # keep the note's own style: a list of `[[Title]]`
                    links = [f"[[{t}]]" for t in titles]
                    extra[key] = links if len(links) > 1 or isinstance(extra.get(key), (list, tuple)) else links[0]
                else:
                    extra[key] = titles if len(titles) > 1 else value
        else:
            extra.pop(key, None)
    return extra

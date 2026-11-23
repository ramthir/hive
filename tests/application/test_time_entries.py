from datetime import date

import pytest

from src.application.notes.time_entries import TimeRow, month_summary, order_time_notes, parse_query, rows_of, select
from src.domain.notes.entities import Note

TODAY = date(2026, 11, 20)


def row(title="Fix login", day="2026-11-20", minutes=60, kind="task", project="", slug=None):
    return TimeRow(slug or title.lower().replace(" ", "-"), title, kind, project, day, minutes)


ROWS = [
    row("Fix login", "2026-11-20", 90, project="Acme"),
    row("Fix login", "2026-11-19", 30, project="Acme"),
    row("Standup", "2026-11-20", 15, "meeting", "Internal"),
    row("Write docs", "2026-10-31", 240),
]


def titles(rows):
    return [(r.title, r.day) for r in rows]


def test_rows_of_a_note_carry_its_type_and_project_and_skip_other_notes():
    n = Note(slug="a", title="A", content="", types=("meeting",), time={"2026-11-20": 30}, extra={"project": " Acme "})
    assert rows_of(n) == [TimeRow("a", "A", "meeting", "Acme", "2026-11-20", 30)]
    assert rows_of(Note(slug="b", title="B", content="", types=("idea",))) == []
    # time left on a retyped note stays visible (and removable) as "other"
    assert rows_of(Note(slug="b", title="B", content="", types=("idea",), time={"2026-11-20": 30}))[0].type == "other"
    assert rows_of(n)[0].id == "a:2026-11-20"


def test_parse_query_splits_free_text_from_filters():
    assert parse_query("fix project:Acme date:today duration:>30m") == (
        "fix", {"project": "Acme", "date": "today", "duration": ">30m"})
    assert parse_query('login project:"Big Co" date:today') == ("login", {"project": "Big Co", "date": "today"})
    assert parse_query('project:"Big Co" login') == ("login", {"project": "Big Co"})
    assert parse_query("just words") == ("just words", {})


def test_rows_come_newest_day_first_then_by_title():
    assert titles(select(ROWS, today=TODAY)) == [
        ("Fix login", "2026-11-20"), ("Standup", "2026-11-20"), ("Fix login", "2026-11-19"), ("Write docs", "2026-10-31")]


def test_date_range_and_note_filter():
    assert titles(select(ROWS, start="2026-11-01", end="2026-11-19", today=TODAY)) == [("Fix login", "2026-11-19")]
    assert len(select(ROWS, slug="fix-login", today=TODAY)) == 2


@pytest.mark.parametrize("query, expected", [
    ("login", 2), ("LOGIN", 2), ("task:docs", 1), ("project:acme", 2), ("project:acme task:login date:yesterday", 1),
    ("date:today", 2), ("date:yesterday", 1), ("date:2026-10-31", 1), ("date:nonsense", 0), ("duration:abc", 0), ("duration:>", 0),
    ("duration:>60", 2), ("duration:>=90", 2), ("duration:<=30", 2), ("duration:15", 1), ("duration:2h", 0),
    ("duration:1h-4h", 2), ("duration:30m-1h", 1), ("duration:4h", 1),
])
def test_search_syntax(query, expected):
    assert len(select(ROWS, query=query, today=TODAY)) == expected


def test_month_summary_counts_only_the_current_month_with_a_breakdown_per_day():
    s = month_summary(ROWS, TODAY)
    assert {k: s[k] for k in ("month", "today", "today_minutes", "total_entries", "total_minutes", "task_minutes",
                              "meeting_minutes")} == {
        "month": "2026-11", "today": "2026-11-20", "today_minutes": 105, "total_entries": 3, "total_minutes": 135,
        "task_minutes": 120, "meeting_minutes": 15}
    assert s["days"] == [
        {"day": "2026-11-19", "minutes": 30, "items": [{"title": "Fix login", "project": "Acme", "minutes": 30}]},
        {"day": "2026-11-20", "minutes": 105, "items": [
            {"title": "Fix login", "project": "Acme", "minutes": 90}, {"title": "Standup", "project": "Internal", "minutes": 15}]},
    ]


def test_month_summary_of_nothing_is_zero():
    s = month_summary([], TODAY)
    assert (s["total_entries"], s["total_minutes"], s["today_minutes"], s["days"]) == (0, 0, 0, [])


def test_month_summary_formats_wiki_link_projects_as_labels():
    rows = [
        row("Sync", "2026-11-20", 15, "meeting", "[[Arrcus]]"),
        row("Fix", "2026-11-20", 30, "task", "[[Acme|Client]]"),
    ]
    [day] = month_summary(rows, TODAY)["days"]
    assert day["items"] == [
        {"title": "Fix", "project": "Client", "minutes": 30},
        {"title": "Sync", "project": "Arrcus", "minutes": 15},
    ]


def test_order_time_notes_puts_the_weeks_first_and_skips_other_types():
    def n(slug, kind, updated, time=None):
        return Note(slug=slug, title=slug.title(), content="", types=(kind,), updated=updated, time=time or {})

    notes = [n("archive", "task", "2026-10-01"), n("billing", "task", "2026-10-01", {"2026-11-18": 30}),
             n("standup", "meeting", "2026-11-17"), n("deploy", "task", "2026-11-19"), n("idea", "idea", "2026-11-19")]
    ordered = order_time_notes(notes, "2026-W47")
    assert [(x.slug, week) for x, week in ordered] == [
        ("deploy", True), ("standup", True), ("billing", True), ("archive", False)]

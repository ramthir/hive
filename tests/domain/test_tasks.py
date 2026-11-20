import re
from datetime import date

import pytest

from src.domain.notes.entities import Note
from src.domain.notes.tasks import STATUSES, WEEK_PATTERN, is_task, task_status, week_label


def note(**kw) -> Note:
    return Note(**{"slug": "n", "title": "N", "content": "# N", **kw})


def test_is_task_matches_the_type_case_insensitively_among_several():
    assert is_task(note(types=("task",)))
    assert is_task(note(types=("contact", "Task")))
    assert not is_task(note(types=("tasks",)))
    assert not is_task(note())


def test_stored_status_wins_over_the_done_tag_and_is_normalised():
    for stored, expected in [("DONE", "DONE"), ("todo", "TODO"), (" in progress ", "IN_PROGRESS"), ("in-progress", "IN_PROGRESS")]:
        assert task_status(note(status=stored, tags=("done",))) == expected


def test_without_a_usable_status_the_done_tag_decides():
    assert task_status(note(tags=("x", "Done"))) == "DONE"
    assert task_status(note(tags=("todo",))) == "TODO"
    assert task_status(note(status="DOING", tags=("done",))) == "DONE"  # unknown status is ignored
    assert task_status(note(status="DOING")) == "TODO"
    assert task_status(note(status="")) == "TODO"


def test_statuses_are_the_three_board_columns():
    assert STATUSES == ("TODO", "IN_PROGRESS", "DONE")


@pytest.mark.parametrize("day,label", [
    (date(2026, 11, 20), "2026-W47"),
    (date(2026, 1, 1), "2026-W01"),
    (date(2027, 1, 1), "2026-W53"),   # the ISO year differs from the calendar year at the edges
    (date(2024, 12, 30), "2025-W01"),
])
def test_week_label_is_the_iso_week(day, label):
    assert week_label(day) == label
    assert re.match(WEEK_PATTERN, label)


def test_week_pattern_bounds():
    for ok in ["2026-W01", "2026-W53", "2026-W47"]:
        assert re.match(WEEK_PATTERN, ok)
    for bad in ["2026-W00", "2026-W54", "2026-W5", "26-W10", "last week", "2026-w10"]:
        assert not re.match(WEEK_PATTERN, bad)


def test_task_week_is_the_stored_week_else_the_updated_day_else_none():
    from src.domain.notes.tasks import task_week

    assert task_week(note(week="2026-W40", updated="2026-11-20")) == ("2026-W40", True)
    assert task_week(note(week="garbage", updated="2026-11-20")) == ("2026-W47", False)
    assert task_week(note(updated="2026-01-01")) == ("2026-W01", False)
    assert task_week(note(updated="nonsense")) == (None, False)
    assert task_week(note()) == (None, False)


def test_priority_is_the_most_urgent_priority_tag():
    from src.domain.notes.tasks import task_priority, with_priority, without_priority

    assert task_priority(["x", "important", "#Must"]) == "must"
    assert task_priority(["#nice-to-have"]) == "nice-to-have"
    assert task_priority(["x", "musts"]) is None
    assert without_priority(["a", "#must", "Important", "b"]) == ("a", "b")
    assert with_priority(["a", "must", "b"], "important") == ("a", "b", "important")
    assert with_priority(["a", "must"], None) == ("a",)
    assert with_priority([], "must") == ("must",)

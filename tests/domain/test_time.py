from datetime import date

from src.domain.notes.entities import Note
from src.domain.notes.time import accepts_time, parse_day, parse_time, time_type


def note(**kw) -> Note:
    return Note(**{"slug": "n", "title": "N", "content": "# N", **kw})


def test_only_task_and_meeting_notes_accept_time():
    assert accepts_time(note(types=("task",)))
    assert accepts_time(note(types=("contact", "Meeting")))
    assert not accepts_time(note(types=("idea",)))
    assert not accepts_time(note())


def test_a_note_that_is_both_counts_as_a_task():
    assert time_type(note(types=("meeting", "task"))) == "task"
    assert time_type(note(types=("meeting",))) == "meeting"
    assert time_type(note(types=("idea",))) is None


def test_parse_day_takes_dates_and_iso_strings_only():
    assert parse_day(date(2026, 11, 20)) == "2026-11-20"
    assert parse_day("2026-11-20") == "2026-11-20"
    assert parse_day("2026-13-40") is None
    assert parse_day("yesterday") is None


def test_parse_time_keeps_the_usable_days_oldest_first():
    raw = {date(2026, 11, 21): 45, "2026-11-20": 90}
    assert parse_time(raw) == {"2026-11-20": 90, "2026-11-21": 45}


def test_parse_time_ignores_bad_days_and_minutes_and_non_maps():
    raw = {"2026-11-20": 0, "2026-11-21": 1441, "2026-11-22": "90", "2026-11-23": True, "2026-11-24": 1.5,
           "nope": 30, "2026-11-25": 1440}
    assert parse_time(raw) == {"2026-11-25": 1440}
    assert parse_time(None) == {}
    assert parse_time([90]) == {}
    assert parse_time("90") == {}

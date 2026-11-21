from dataclasses import replace

from src.domain.notes.changes import describe, duration
from src.domain.notes.entities import Note

BASE = Note(slug="a", title="A", content="# A\n\nintro\n\n## Plan\n\none\n", types=("task",), status="TODO")


def test_first_commit_is_created():
    assert describe(None, BASE).kind == "created"


def test_restore_is_read_from_the_commit_message():
    change = describe(BASE, BASE, "doc: restore A to 8a31185")
    assert (change.kind, change.detail) == ("restore", "8a31185")


def test_text_edit_names_the_section():
    new = replace(BASE, content=BASE.content + "two\n")
    change = describe(BASE, new)
    assert (change.kind, change.summary, change.detail) == ("text", "Edited text", "Plan")


def test_edit_under_the_title_has_no_section():
    change = describe(BASE, replace(BASE, content=BASE.content.replace("intro", "hello")))
    assert change.detail == ""


def test_status_move_and_week():
    change = describe(BASE, replace(BASE, status="DONE", week="2026-W47"))
    assert (change.kind, change.summary) == ("properties", "Moved to Done")


def test_time_logged_and_removed():
    logged = describe(BASE, replace(BASE, time={"2026-11-20": 90}))
    assert (logged.kind, logged.summary, logged.detail) == ("time", "Logged 1h 30m", "20 Nov")
    more = describe(replace(BASE, time={"2026-11-20": 30}), replace(BASE, time={"2026-11-20": 90}))
    assert more.summary == "Logged 1h"
    gone = describe(replace(BASE, time={"2026-11-20": 30}), BASE)
    assert gone.summary == "Removed time"


def test_tags_and_priority():
    assert describe(BASE, replace(BASE, tags=("x", "y"))).summary == "Added x, y"
    assert describe(replace(BASE, tags=("x",)), BASE).summary == "Removed x"
    assert describe(BASE, replace(BASE, tags=("must",))).summary == "Set priority to must"


def test_rename_and_mixed_changes_list_every_kind():
    change = describe(BASE, replace(BASE, title="B", content="# B\n"), old_path="a.md", new_path="b.md")
    assert {"rename", "text"} <= set(change.kinds) and change.summary.startswith("Renamed to B")
    mixed = describe(BASE, replace(BASE, status="DONE", content=BASE.content + "x\n", time={"2026-11-20": 5}))
    assert set(mixed.kinds) == {"properties", "text", "time"} and mixed.kind == "text"
    assert mixed.summary.endswith("+1 more")


def test_a_save_with_nothing_visible():
    assert describe(BASE, BASE).kind == "saved"


def test_durations():
    assert [duration(m) for m in (5, 60, 90)] == ["5m", "1h", "1h 30m"]


def test_property_changes_list_keys_with_old_and_new_bookkeeping_last():
    from src.domain.notes.changes import property_changes

    new = replace(BASE, status="DONE", week="2026-W47", tags=("x",), updated="2026-11-21", extra={"ticket": "ABC-1"})
    got = [(c.key, c.old, c.new, c.minor) for c in property_changes(replace(BASE, updated="2026-11-20"), new)]
    assert got == [("status", "TODO", "DONE", False), ("tags", None, "x", False), ("ticket", None, "ABC-1", False),
                   ("week", None, "2026-W47", False), ("updated", "2026-11-20", "2026-11-21", True)]
    assert property_changes(BASE, BASE) == []
    assert [c.key for c in property_changes(None, BASE)] == ["status", "type"]

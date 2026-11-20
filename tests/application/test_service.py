import subprocess
from datetime import date

import pytest

from src.application.notes.service import NoteService
from src.domain.notes.errors import InvalidTime, InvalidTitle, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


@pytest.fixture
def day():
    return {"today": date(2026, 11, 20)}


@pytest.fixture
def svc(root, day):
    return NoteService(FileNoteRepository(root, today=lambda: day["today"]))


def test_title_is_the_h1_and_the_file_name_is_its_kebab_case(svc, root):
    n = svc.create("Hello World", "some text")
    assert (n.slug, n.title) == ("hello-world", "Hello World")
    assert n.content == "# Hello World\n\nsome text"
    assert (root / "hello-world.md").read_text().startswith("---\ntitle: Hello World\n")
    # a heading in the content wins over the title argument
    m = svc.create(None, "# Own Heading\n\nbody")
    assert (m.slug, m.title) == ("own-heading", "Own Heading")


def test_duplicate_titles_get_numbered_files(svc):
    assert svc.create("Same").slug == "same"
    assert svc.create("Same").slug == "same-2"
    assert svc.create("Same").slug == "same-3"


def test_create_needs_a_title(svc):
    for args in [(None, ""), ("  ", "body"), (None, "#\nbody"), (None, "no heading")]:
        with pytest.raises(InvalidTitle):
            svc.create(*args)


def test_update_keeps_title_and_file_when_heading_is_unchanged(svc, root):
    svc.create("A", "one")
    n = svc.update("a", content="# A\n\ntwo")
    assert (n.slug, n.content) == ("a", "# A\n\ntwo")
    assert svc.update("a", tags=("t",)).tags == ("t",)
    assert not any(p.name != "a.md" for p in root.glob("*.md"))


def test_update_without_a_heading_keeps_the_current_title(svc):
    svc.create("A", "one")
    n = svc.update("a", content="just text")
    assert (n.title, n.content) == ("A", "# A\n\njust text")


def test_update_rejects_an_emptied_heading(svc):
    svc.create("A")
    with pytest.raises(InvalidTitle):
        svc.update("a", content="# \n\ntext")


def test_changing_the_heading_renames_the_file_and_relinks(svc, root):
    svc.create("Old Name", "body")
    svc.create("Linker", "[[old-name]] [[Old Name]] [[Old Name|Label]] [[other]]")
    n = svc.update("old-name", content="# New Name\n\nbody")
    assert (n.slug, n.title) == ("new-name", "New Name")
    assert not (root / "old-name.md").exists() and (root / "new-name.md").exists()
    assert svc.get("linker").content.endswith("[[new-name]] [[New Name]] [[New Name|Label]] [[other]]")
    assert [b.slug for b in svc.backlinks("new-name")] == ["linker"]
    assert svc.index.unresolved == {"linker": ["other"]}
    assert len(svc.versions("new-name")) == 3  # created, renamed, updated: history follows the file


def test_title_change_that_collides_gets_a_suffix(svc):
    svc.create("Taken")
    svc.create("Other")
    assert svc.update("other", content="# Taken\n").slug == "taken-2"


def test_existing_file_names_are_left_alone_unless_the_title_changes(svc, root):
    (root / "legacy_name.md").write_text("---\ntitle: Fancy Title\n---\n\n# Fancy Title\n\nx\n")
    git(root, "add", "-A"); git(root, "commit", "-qm", "legacy")
    assert svc.update("legacy_name", content="# Fancy Title\n\nedited").slug == "legacy_name"
    assert svc.update("legacy_name", content="# Better Title\n\nedited").slug == "better-title"


def test_title_argument_rewrites_the_heading(svc):
    svc.create("A", "text")
    assert svc.update("a", title="B").content == "# B\n\ntext"
    assert svc.get("b").title == "B"


def test_backlinks_by_slug_and_title(svc):
    svc.create("Target")
    svc.create("One", "see [[target]]")
    svc.create("Two", "see [[Target|x]] and [[missing]]")
    assert [n.slug for n in svc.backlinks("target")] == ["one", "two"]
    assert svc.index.unresolved == {"two": ["missing"]}
    with pytest.raises(NoteNotFound):
        svc.backlinks("nope")


def test_self_links_are_not_backlinks(svc):
    svc.create("A", "[[a]]")
    assert svc.backlinks("a") == []


def test_ambiguous_titles_flagged(svc, root):
    for slug in ("dup-1", "dup-2"):
        (root / f"{slug}.md").write_text("---\ntitle: Dup\n---\n\n# Dup\n")
    svc.create("L", "[[Dup]]")
    assert svc.index.resolve("Dup") == "dup-1"
    assert svc.index.ambiguous == {"Dup": ["dup-1", "dup-2"]}


def test_tags_and_search_ranking(svc):
    svc.create("Python tips", "x", tags=("code",))
    svc.create("Notes", "mentions python once", tags=("code", "misc"))
    svc.create("Other", "nothing")
    assert svc.tags() == {"code": 2, "misc": 1}
    assert [h.note.slug for h in svc.search("python")] == ["python-tips", "notes"]
    assert [h.note.slug for h in svc.search("", tag="misc")] == ["notes"]
    assert svc.search("python missingword") == []
    assert [n.slug for n in svc.list(tag="code")] == ["notes", "python-tips"]


def test_resolution_ignores_punctuation_and_anchors(svc):
    svc.create("ADR: Standard")
    svc.create("L", "[[ADR Standard]] [[adr-standard#Heading]] [[#local]]")
    assert [n.slug for n in svc.backlinks("adr-standard")] == ["l"]
    assert svc.index.unresolved == {}


def test_latest_is_the_most_recently_edited(svc, day):
    with pytest.raises(NoteNotFound):
        svc.latest()
    day["today"] = date(2026, 11, 1)
    svc.create("Old")
    day["today"] = date(2026, 11, 18)
    svc.create("Newer")
    assert svc.latest().slug == "newer"
    day["today"] = date(2026, 11, 20)
    svc.update("old", content="# Old\n\nedited today")
    assert svc.latest().slug == "old"
    svc.create("Same Day Later")
    assert svc.latest().slug == "same-day-later"  # same `updated` day: the newer file wins


def test_restore_brings_back_the_old_title_and_file_name(svc, root):
    svc.create("First Name", "v1")
    first = svc.versions("first-name")[-1].sha
    svc.update("first-name", content="# Second Name\n\nv2")
    assert (root / "second-name.md").exists()
    restored = svc.restore("second-name", first)
    assert (restored.slug, restored.title) == ("first-name", "First Name")
    assert not (root / "second-name.md").exists()


def test_delete_and_index_refresh(svc):
    svc.create("A", "one")
    svc.update("a", content="# A\n\ntwo")
    first = svc.versions("a")[-1].sha
    assert svc.restore("a", first).content.endswith("one")
    svc.delete("a")
    assert svc.list() == []


def test_types_are_an_optional_list_in_frontmatter(svc, root):
    plain = svc.create("Plain")
    assert plain.types == () and "type:" not in (root / "plain.md").read_text()
    task = svc.create("Do It", tags=("a", "b"), types=(" task ", "task", "urgent"))
    assert task.types == ("task", "urgent")  # trimmed and de-duplicated
    # new lists are written inline (the vault's convention), right after the tags rather than at the end
    assert (root / "do-it.md").read_text().startswith("---\ntitle: Do It\ntags: [a, b]\ntype: [task, urgent]\ncreated:")
    assert svc.types() == {"task": 1, "urgent": 1}


def test_update_types_changes_clears_and_otherwise_keeps(svc, root):
    svc.create("N", types=("note",))
    assert svc.update("n", content="# N\n\nedited").types == ("note",)  # omitted: unchanged
    assert svc.update("n", types=("task", "contact")).types == ("task", "contact")
    assert svc.update("n", types=()).types == ()  # empty clears it
    assert "type:" not in (root / "n.md").read_text()


def test_types_survive_a_title_rename_and_a_restore(svc):
    svc.create("Old", types=("contact",))
    renamed = svc.update("old", content="# New\n\nx")
    assert (renamed.slug, renamed.types) == ("new", ("contact",))
    svc.update("new", types=("task",))
    assert svc.restore("new", svc.versions("new")[-1].sha).types == ("contact",)  # the first version had contact


def test_a_files_own_type_style_is_read_and_left_alone(svc, root):
    """The vault stores `type` as a block list, a flow list or a scalar; editing the note must not rewrite it."""
    for slug, line, expected in [("block", "type:\n  - note\n  - glossary", ("note", "glossary")),
                                 ("flow", "type: [contact, interview]", ("contact", "interview")),
                                 ("scalar", "type: task", ("task",))]:
        (root / f"{slug}.md").write_text(f"---\ntitle: T {slug}\n{line}\ntags:\n  - t\n---\n\n# T {slug}\n")
        git(root, "add", "-A"); git(root, "commit", "-qm", slug)
        assert svc.get(slug).types == expected and svc.get(slug).extra == {}
        svc.update(slug, content=f"# T {slug}\n\nedited")
        assert (root / f"{slug}.md").read_text().startswith(f"---\ntitle: T {slug}\n{line}\ntags:\n  - t\n")
    assert svc.types() == {"note": 1, "glossary": 1, "contact": 1, "interview": 1, "task": 1}


def test_tags_and_types_keep_a_files_own_style_until_they_change(svc, root):
    """Saving must not reformat lists that did not change; a list that does change is written inline."""
    (root / "block.md").write_text("---\ntitle: Block\ntags:\n  - a\n  - b\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Block\n")
    (root / "inline.md").write_text("---\ntitle: Inline\ntags: [a, b]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Inline\n")
    (root / "bare.md").write_text("---\ntitle: Bare\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Bare\n")
    git(root, "add", "-A"); git(root, "commit", "-qm", "seed")
    for slug in ("block", "inline", "bare"):  # an edit that leaves tags and types alone
        svc.update(slug, content=f"# {slug.title()}\n\nedited")
    assert "tags:\n  - a\n  - b\n" in (root / "block.md").read_text()      # block list untouched
    assert "tags: [a, b]\n" in (root / "inline.md").read_text()             # inline list untouched
    assert "tags" not in (root / "bare.md").read_text()                       # nothing invented
    svc.update("block", tags=("a", "b", "c"))
    assert "tags: [a, b, c]\n" in (root / "block.md").read_text()            # changed: now inline
    svc.update("bare", tags=("x",), types=("note",))
    assert (root / "bare.md").read_text().startswith("---\ntitle: Bare\ntags: [x]\ntype: note\ncreated:")  # one type: a scalar
    svc.update("inline", tags=())
    assert "tags: []\n" in (root / "inline.md").read_text()
    assert svc.get("block").tags == ("a", "b", "c")


def test_tags_with_special_characters_are_quoted_inline(svc, root):
    svc.create("Odd", tags=("a, b", "c: d", "plain"))
    assert svc.get("odd").tags == ("a, b", "c: d", "plain")  # survives a round trip
    assert "tags: [" in (root / "odd.md").read_text()


def test_one_type_is_written_as_a_scalar_and_several_as_an_inline_list(svc, root):
    svc.create("One", types=("task",))
    assert "\ntype: task\n" in (root / "one.md").read_text()
    svc.update("one", types=("task", "urgent"))
    assert "\ntype: [task, urgent]\n" in (root / "one.md").read_text()
    svc.update("one", types=("contact",))
    assert "\ntype: contact\n" in (root / "one.md").read_text()
    assert svc.get("one").types == ("contact",)
    svc.update("one", content="# One\n\nedited")  # untouched when unchanged
    assert "\ntype: contact\n" in (root / "one.md").read_text()


def test_finishing_a_task_uses_the_service_clock_for_its_week(svc, day):
    svc.create("Job", types=("task",))
    day["today"] = date(2026, 11, 20)
    assert svc.update("job", status="DONE").week == "2026-W47"
    assert svc.update("job", status="DONE").week == "2026-W47"  # re-saving DONE is not a transition
    day["today"] = date(2026, 12, 1)
    assert svc.update("job", content="# Job\n\nedited").week == "2026-W47"
    assert svc.update("job", status="IN_PROGRESS").week is None


def test_a_task_done_by_tag_loses_nothing_until_moved_out_of_done(svc):
    svc.create("Old", types=("task",), tags=("done",))
    assert svc.update("old", status="DONE").week is None  # already Done through its tag
    moved = svc.update("old", status="TODO")
    assert (moved.status, moved.week) == ("TODO", None)


def test_tasks_lists_only_task_notes_newest_first(svc, day):
    svc.create("Plain")
    day["today"] = date(2026, 11, 1)
    svc.create("First", types=("task",))
    day["today"] = date(2026, 11, 2)
    svc.create("Second", types=("task", "urgent"))
    assert [n.slug for n in svc.tasks()] == ["second", "first"]


# -- logging time ----------------------------------------------------------
def _task(svc, title="Fix login", types=("task",)):
    return svc.create(title, "", types=types)


def test_log_time_sets_the_minutes_of_a_day_in_one_commit(svc, root):
    _task(svc)
    before = len(git(root, "rev-list", "HEAD").split())
    r = svc.log_time("fix-login", "2026-11-20", 90)
    assert (r.id, r.minutes, r.type) == ("fix-login:2026-11-20", 90, "task")
    assert svc.log_time("fix-login", "2026-11-20", 45).minutes == 45  # set replaces
    assert svc.get("fix-login").time == {"2026-11-20": 45}
    assert len(git(root, "rev-list", "HEAD").split()) == before + 2
    assert "time: {2026-11-20: 45}" in (root / "fix-login.md").read_text()


def test_log_time_with_add_adds_to_the_day(svc):
    _task(svc)
    svc.log_time("fix-login", "2026-11-20", 60)
    assert svc.log_time("fix-login", "2026-11-20", 30, add=True).minutes == 90
    assert svc.log_time("fix-login", "2026-11-21", 30, add=True).minutes == 30


def test_log_time_rejects_other_notes_bad_days_and_too_many_minutes(svc):
    _task(svc)
    svc.create("Idea", "", types=("idea",))
    with pytest.raises(InvalidTime):
        svc.log_time("idea", "2026-11-20", 30)
    with pytest.raises(InvalidTime):
        svc.log_time("fix-login", "yesterday", 30)
    with pytest.raises(InvalidTime):
        svc.log_time("fix-login", "2026-11-20", 0)
    svc.log_time("fix-login", "2026-11-20", 1400)
    with pytest.raises(InvalidTime):
        svc.log_time("fix-login", "2026-11-20", 100, add=True)
    assert svc.get("fix-login").time == {"2026-11-20": 1400}
    with pytest.raises(NoteNotFound):
        svc.log_time("missing", "2026-11-20", 30)


def test_remove_time_drops_the_day_and_the_key_with_the_last_one(svc, root):
    _task(svc)
    svc.log_time("fix-login", "2026-11-20", 60)
    svc.log_time("fix-login", "2026-11-21", 30)
    svc.remove_time("fix-login", "2026-11-20")
    assert svc.get("fix-login").time == {"2026-11-21": 30}
    svc.remove_time("fix-login", "2026-11-21")
    assert "time" not in (root / "fix-login.md").read_text()
    with pytest.raises(NoteNotFound):
        svc.remove_time("fix-login", "2026-11-21")


def test_time_can_still_be_removed_from_a_note_that_is_no_longer_a_task(svc):
    _task(svc)
    svc.log_time("fix-login", "2026-11-20", 60)
    svc.update("fix-login", types=[])
    with pytest.raises(InvalidTime):
        svc.log_time("fix-login", "2026-11-21", 30)
    svc.remove_time("fix-login", "2026-11-20")
    assert svc.get("fix-login").time == {}


def test_logging_time_does_not_touch_status_week_or_the_body(svc, root):
    svc.create("Fix login", "body text", types=("task",))
    svc.update("fix-login", status="DONE")
    before = svc.get("fix-login")
    svc.log_time("fix-login", "2026-11-20", 60)
    after = svc.get("fix-login")
    assert (after.status, after.week, after.content, after.tags, after.types) == (
        before.status, before.week, before.content, before.tags, before.types)


def test_time_rows_search_every_task_and_meeting(svc):
    _task(svc, "Fix login")
    _task(svc, "Standup", ("meeting",))
    svc.log_time("fix-login", "2026-11-20", 90)
    svc.log_time("standup", "2026-11-20", 15)
    assert [(r.title, r.minutes) for r in svc.time_rows()] == [("Fix login", 90), ("Standup", 15)]
    assert [r.title for r in svc.time_rows(query="stand")] == ["Standup"]
    summary = svc.time_summary(svc.time_rows())
    assert {k: summary[k] for k in ("total_entries", "total_minutes", "task_minutes", "meeting_minutes", "today_minutes")} == {
        "total_entries": 2, "total_minutes": 105, "task_minutes": 90, "meeting_minutes": 15, "today_minutes": 105}


def _seed_note(root, name, types, updated, time=""):
    (root / f"{name}.md").write_text(
        f"---\ntitle: {name.title()}\ntype: {types}\ncreated: 2026-01-01\nupdated: {updated}\n{time}---\n\n# {name.title()}\n")


@pytest.fixture
def clock_svc(root, day):
    """A service whose own clock is the fixed `day` (the `svc` fixture fixes only the repository's)."""
    return NoteService(FileNoteRepository(root, today=lambda: day["today"]), today=lambda: day["today"])


def test_time_notes_put_this_weeks_first(clock_svc, root):
    svc = clock_svc
    # today is Fri 2026-11-20, in week 2026-W47 (Mon 16th to Sun 22nd)
    _seed_note(root, "archive", "task", "2026-10-01")
    _seed_note(root, "billing", "task", "2026-10-01", "time: {2026-11-18: 30}\n")   # logged this week
    _seed_note(root, "standup", "meeting", "2026-11-17")                            # edited this week
    _seed_note(root, "deploy", "task", "2026-11-19")                                # edited this week, newest
    _seed_note(root, "idea", "idea", "2026-11-19")                                  # takes no time
    _seed_note(root, "old-log", "task", "2026-10-01", "time: {2026-11-15: 30}\n")  # logged the Sunday before the week
    svc.invalidate()
    assert [(n.slug, week) for n, week in svc.time_notes()] == [
        ("deploy", True), ("standup", True), ("billing", True), ("archive", False), ("old-log", False)]


def test_time_notes_follow_the_service_clock(clock_svc, root, day):
    svc = clock_svc
    _seed_note(root, "deploy", "task", "2026-11-19")
    svc.invalidate()
    assert [week for _, week in svc.time_notes()] == [True]
    day["today"] = date(2026, 11, 30)  # a later week: the same note is no longer this week's
    assert [week for _, week in svc.time_notes()] == [False]

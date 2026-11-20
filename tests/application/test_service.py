import subprocess
from datetime import date

import pytest

from src.application.notes.service import NoteService
from src.domain.notes.errors import InvalidTitle, NoteNotFound
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


def test_type_is_optional_and_lives_in_frontmatter(svc, root):
    plain = svc.create("Plain")
    assert plain.type is None and "type:" not in (root / "plain.md").read_text()
    task = svc.create("Do It", tags=("a", "b"), type=" task ")
    assert task.type == "task"
    # a new key goes right after the tags, not at the end of the frontmatter
    assert (root / "do-it.md").read_text().startswith("---\ntitle: Do It\ntags:\n  - a\n  - b\ntype: task\ncreated:")
    assert svc.types() == {"task": 1}


def test_update_type_changes_clears_and_otherwise_keeps(svc, root):
    svc.create("N", type="note")
    assert svc.update("n", content="# N\n\nedited").type == "note"  # omitted: unchanged
    assert svc.update("n", type="task").type == "task"
    assert (root / "n.md").read_text().count("type: task") == 1
    assert svc.update("n", type="  ").type is None  # blank clears it
    assert "type:" not in (root / "n.md").read_text()


def test_type_survives_a_title_rename_and_a_restore(svc):
    svc.create("Old", type="contact")
    first = svc.versions("old")[-1].sha
    renamed = svc.update("old", content="# New\n\nx")
    assert (renamed.slug, renamed.type) == ("new", "contact")
    svc.update("new", type="task")
    assert svc.restore("new", svc.versions("new")[-1].sha).type == "contact"  # the version had type: contact


def test_existing_type_key_in_a_file_is_read_and_kept_in_place(svc, root):
    (root / "x.md").write_text("---\ntitle: X\ntype: contact\ntags:\n  - t\n---\n\n# X\n")
    git(root, "add", "-A"); git(root, "commit", "-qm", "x")
    assert svc.get("x").type == "contact" and svc.get("x").extra == {}
    svc.update("x", content="# X\n\nedited")
    assert (root / "x.md").read_text().startswith("---\ntitle: X\ntype: contact\ntags:\n  - t\n")

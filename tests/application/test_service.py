import subprocess
from datetime import date

import pytest

from src.application.notes.service import NoteService
from src.domain.notes.errors import NoteExists, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


@pytest.fixture
def svc(root):
    return NoteService(FileNoteRepository(root, today=lambda: date(2026, 11, 20)))


def test_create_derives_unique_slug(svc):
    assert svc.create("Hello World").slug == "hello-world"
    assert svc.create("Hello World").slug == "hello-world-2"
    with pytest.raises(NoteExists):
        svc.create("x", slug="hello-world")


def test_update_partial_fields(svc):
    svc.create("A", "body", tags=("t",))
    n = svc.update("a", content="new")
    assert (n.title, n.content, n.tags) == ("A", "new", ("t",))
    assert svc.update("a", tags=()).tags == ()


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


def test_ambiguous_titles_flagged(svc):
    svc.create("Dup", slug="dup-1")
    svc.create("Dup", slug="dup-2")
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


def test_rename_rewrites_slug_links_only(svc, root):
    svc.create("Old")
    svc.create("Linker", "[[old]] [[old|Lbl]] [[Old]]")
    svc.rename("old", "new")
    assert svc.get("linker").content == "[[new]] [[new|Lbl]] [[Old]]"
    assert svc.index.unresolved == {}  # [[Old]] still resolves via title
    assert [n.slug for n in svc.backlinks("new")] == ["linker"]
    assert git(root, "log", "--format=%s").splitlines()[:2] == ["doc: update Linker", "doc: rename old to new"]


def test_index_refreshes_after_delete_and_restore(svc):
    svc.create("A", "one")
    svc.update("a", content="two")
    first = svc.versions("a")[-1].sha
    assert svc.restore("a", first).content == "one"
    assert svc.get_version("a", first).content == "one"
    svc.delete("a")
    assert svc.list() == []


def test_resolution_ignores_punctuation_and_anchors(svc):
    svc.create("ADR: Standard")
    svc.create("L", "[[ADR Standard]] [[adr-standard#Heading]] [[#local]]")
    assert [n.slug for n in svc.backlinks("adr-standard")] == ["l"]
    assert svc.index.unresolved == {}

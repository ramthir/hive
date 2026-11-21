import subprocess
from datetime import date
from dataclasses import replace
from pathlib import Path

import pytest

from src.domain.notes.entities import Note
from src.domain.notes.errors import InvalidSlug, NoteExists, NoteNotFound
from src.infrastructure.fs_notes import frontmatter
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "Test")
    git(tmp_path, "config", "user.email", "t@example.com")
    (tmp_path / "seed.txt").write_text("x")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-qm", "seed")
    return tmp_path


@pytest.fixture
def repo(root):
    return FileNoteRepository(root, today=lambda: date(2026, 11, 20))


def commits(root):
    return git(root, "log", "--format=%s").splitlines()


def test_create_writes_frontmatter_and_commits(repo, root):
    note = repo.create(Note(slug="hello", title="Hello", content="# Hi\n", tags=("a", "b")))
    text = (root / "hello.md").read_text()
    assert text == "---\ntitle: Hello\ntags: [a, b]\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n\n# Hi\n"
    assert note.content == "# Hi\n" and note.tags == ("a", "b") and note.created == "2026-11-20"
    assert commits(root)[0] == "doc: add Hello"


def test_create_duplicate_and_bad_slug(repo):
    repo.create(Note(slug="a", title="A", content=""))
    with pytest.raises(NoteExists):
        repo.create(Note(slug="a", title="A", content=""))
    for bad in ["", "../x", "a/b", ".hidden"]:
        with pytest.raises(InvalidSlug):
            repo.get(bad)


def test_update_preserves_key_order_quotes_and_extras(repo, root):
    (root / "n.md").write_text("---\ntitle: '21 Days'\ntags:\n  - note\ncreated: 2025-11-19\nupdated: 2025-11-19\naliases: [x]\n---\n\nbody\n")
    git(root, "add", "-A"); git(root, "commit", "-qm", "n")
    note = repo.get("n")
    repo.update(Note(slug="n", title="21 Days", content="new\n", tags=note.tags, extra=note.extra))
    text = (root / "n.md").read_text()
    assert text.startswith("---\ntitle: '21 Days'\ntags:\n  - note\ncreated: 2025-11-19\nupdated: 2026-11-20\naliases: [x]\n---\n\nnew\n")
    assert commits(root)[0] == "doc: update 21 Days"


def test_update_missing_raises(repo):
    with pytest.raises(NoteNotFound):
        repo.update(Note(slug="nope", title="N", content=""))


def test_noop_update_makes_no_commit(repo, root):
    repo.create(Note(slug="a", title="A", content="x"))
    before = commits(root)
    repo.update(repo.get("a"))
    assert commits(root) == before


def test_commit_is_limited_to_the_note(repo, root):
    repo.create(Note(slug="a", title="A", content="x"))
    (root / "other.md").write_text("dirty")
    (root / "staged.md").write_text("staged")
    git(root, "add", "staged.md")
    repo.update(Note(slug="a", title="A", content="y"))
    assert git(root, "show", "--name-only", "--format=", "HEAD").split() == ["a.md"]
    assert "staged.md" in git(root, "diff", "--cached", "--name-only")
    assert (root / "other.md").exists()


def test_rename_keeps_history(repo, root):
    repo.create(Note(slug="old", title="Old", content="x"))
    repo.update(Note(slug="old", title="Old", content="y"))
    repo.rename("old", "new")
    assert not (root / "old.md").exists()
    assert commits(root)[0] == "doc: rename old to new"
    assert len(repo.versions("new")) == 3
    with pytest.raises(NoteExists):
        repo.create(Note(slug="new", title="x", content=""))


def test_delete_commits_removal(repo, root):
    repo.create(Note(slug="a", title="A", content="x"))
    repo.delete("a")
    assert not (root / "a.md").exists()
    assert commits(root)[0] == "doc: delete A"
    with pytest.raises(NoteNotFound):
        repo.delete("a")


def test_versions_get_and_restore(repo, root):
    repo.create(Note(slug="a", title="A", content="one"))
    repo.update(Note(slug="a", title="A", content="two"))
    versions = repo.versions("a")
    assert [v.message for v in versions] == ["doc: update A", "doc: add A"]
    first = versions[-1]
    assert repo.get_version("a", first.sha).content == "one"
    restored = repo.restore("a", first.sha[:8])
    assert restored.content == "one"
    assert commits(root)[0].startswith("doc: restore A to ")
    assert len(repo.versions("a")) == 3
    with pytest.raises(NoteNotFound):
        repo.get_version("a", "deadbeef")


def test_versions_count_lines_changed(repo):
    repo.create(Note(slug="a", title="A", content="one\ntwo"))
    repo.update(Note(slug="a", title="A", content="one\nthree\nfour"))
    newest, oldest = repo.versions("a")
    assert oldest.added > 0 and oldest.removed == 0
    assert newest.added >= 2 and newest.removed >= 1


def test_get_version_after_rename_uses_old_path(repo):
    repo.create(Note(slug="old", title="Old", content="one"))
    repo.rename("old", "new")
    oldest = repo.versions("new")[-1]
    assert oldest.path == "old.md"
    assert repo.get_version("new", oldest.sha).content == "one"


def test_list_only_markdown(repo, root):
    repo.create(Note(slug="b", title="B", content=""))
    repo.create(Note(slug="a", title="A", content=""))
    assert [n.slug for n in repo.list()] == ["a", "b"]


def test_note_without_frontmatter_parses(repo, root):
    (root / "plain.md").write_text("just text\n")
    n = repo.get("plain")
    assert n.title == "plain" and n.content == "just text\n"


def test_frontmatter_roundtrip_edge_cases():
    for text in ["---\ntitle: 'A'\n---\n", "---\ntitle: A\ntags:\n  - x\n---\n\nbody\n\n\nmore\n"]:
        meta, body = frontmatter.split(text)
        assert frontmatter.render(meta, body) == text


# -- time ------------------------------------------------------------------
TASK = "---\ntitle: T\ntags: [a]\ntype: task\nstatus: TODO\nweek: 2026-W47\ncreated: 2026-11-01\nupdated: 2026-11-01\n---\n\n# T\n"


def seed(root, name, text):
    (root / name).write_text(text)
    git(root, "add", "-A")
    git(root, "commit", "-qm", f"seed {name}")


def test_time_is_read_from_the_frontmatter(repo, root):
    seed(root, "t.md", TASK.replace("---\n\n#", "time: {2026-11-21: 45, 2026-11-20: 90}\n---\n\n#"))
    assert repo.get("t").time == {"2026-11-20": 90, "2026-11-21": 45}
    assert "time" not in repo.get("t").extra


def test_logging_time_writes_an_inline_map_after_week(repo, root):
    seed(root, "t.md", TASK)
    note = repo.get("t")
    repo.update(replace(note, time={"2026-11-21": 45, "2026-11-20": 90}))
    text = (root / "t.md").read_text()
    assert "week: 2026-W47\ntime: {2026-11-20: 90, 2026-11-21: 45}\ncreated:" in text
    assert repo.get("t").time == {"2026-11-20": 90, "2026-11-21": 45}
    assert commits(root)[0] == "doc: update T"


def test_changing_a_day_rewrites_only_the_time_line(repo, root):
    seed(root, "t.md", TASK.replace("---\n\n#", "time: {2026-11-20: 90}\n---\n\n#"))
    repo.update(replace(repo.get("t"), time={"2026-11-20": 120}))
    diff = [l for l in git(root, "diff", "HEAD~1", "--", "t.md").splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---")]
    assert diff == ["-updated: 2026-11-01", "-time: {2026-11-20: 90}", "+updated: 2026-11-20", "+time: {2026-11-20: 120}"]


def test_an_unrelated_save_leaves_the_time_line_as_written(repo, root):
    seed(root, "t.md", TASK.replace("---\n\n#", "time:\n  2026-11-20: 90\n---\n\n#"))
    repo.update(replace(repo.get("t"), tags=("a", "b")))
    assert "time:\n  2026-11-20: 90\n" in (root / "t.md").read_text()


def test_clearing_every_day_removes_the_key(repo, root):
    seed(root, "t.md", TASK.replace("---\n\n#", "time: {2026-11-20: 90}\n---\n\n#"))
    repo.update(replace(repo.get("t"), time={}))
    assert "time" not in (root / "t.md").read_text()


def test_entries_that_are_not_a_valid_day_are_kept_when_time_changes(repo, root):
    seed(root, "t.md", TASK.replace("---\n\n#", "time: {2026-11-20: 90, soon: 30, 2026-11-22: 0}\n---\n\n#"))
    repo.update(replace(repo.get("t"), time={"2026-11-20": 100}))
    assert "time: {2026-11-20: 100, soon: 30, 2026-11-22: 0}" in (root / "t.md").read_text()


def test_list_reparses_only_files_that_changed(repo, root, monkeypatch):
    repo.create(Note(slug="one", title="One", content="# One\n\nbody"))
    repo.create(Note(slug="two", title="Two", content="# Two\n\nbody"))
    assert [n.slug for n in repo.list()] == ["one", "two"]

    parsed = []
    real = repo._parse
    monkeypatch.setattr(repo, "_parse", lambda slug, *a, **k: (parsed.append(slug), real(slug, *a, **k))[1])
    assert [n.slug for n in repo.list()] == ["one", "two"]
    assert parsed == []  # nothing changed: nothing parsed

    (root / "two.md").write_text("---\ntitle: Two\n---\n\n# Two\n\nedited elsewhere\n")
    assert [n.content for n in repo.list()][1].endswith("edited elsewhere\n")
    assert parsed == ["two"]  # only the edited file

    (root / "two.md").unlink()
    (root / "three.md").write_text("# Three\n")
    assert [n.slug for n in repo.list()] == ["one", "three"]  # deletions and additions are noticed


def test_version_changes_describe_each_commit_even_across_page_edges(repo):
    note = repo.create(Note(slug="t", title="T", content="# T\n\n## Plan\n\none\n", types=("task",), status="TODO"))
    note = repo.update(replace(note, status="DONE"))
    note = repo.update(replace(note, time={"2026-11-20": 90}))
    note = repo.update(replace(note, content=note.content + "two\n"))
    everything = repo.version_changes("t")
    assert [(v.kind, v.summary) for v in everything] == [
        ("text", "Edited text"), ("time", "Logged 1h 30m"), ("properties", "Moved to Done"), ("created", "Created the note")]
    assert everything[0].detail == "Plan"
    pages = repo.version_changes("t", limit=2) + repo.version_changes("t", limit=2, offset=2)
    assert [(v.sha, v.kind) for v in pages] == [(v.sha, v.kind) for v in everything]

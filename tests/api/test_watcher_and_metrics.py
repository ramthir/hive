import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.domain.notes.entities import Note
from src.domain.notes.errors import GitError
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


def wait_until(predicate, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_external_edits_are_picked_up_without_reindex(root):
    with TestClient(create_app(root, watch=True)) as client:
        client.post("/api/notes", json={"title": "A"})
        assert [n["slug"] for n in client.get("/api/notes").json()] == ["a"]
        time.sleep(0.5)  # let the watcher arm
        (root / "b.md").write_text("---\ntitle: B\n---\n\nhi\n")
        assert wait_until(lambda: [n["slug"] for n in client.get("/api/notes").json()] == ["a", "b"])
        (root / "b.md").unlink()
        assert wait_until(lambda: [n["slug"] for n in client.get("/api/notes").json()] == ["a"])
        m = client.get("/api/metrics").json()
        assert m["watcher"] is True and m["counters"]["watcher_batches"] >= 2


def test_burst_of_changes_causes_few_rebuilds(root):
    with TestClient(create_app(root, watch=True)) as client:
        client.get("/api/notes")
        time.sleep(0.5)
        for i in range(60):
            (root / f"n{i}.md").write_text(f"---\ntitle: N{i}\n---\n\nbody\n")
        assert wait_until(lambda: len(client.get("/api/notes", params={"limit": 1000}).json()) == 60)
        m = client.get("/api/metrics").json()
        assert m["counters"]["watcher_batches"] <= 5  # debounced, not one batch per file
        assert m["timings"]["index_rebuild"]["count"] <= 8


def test_non_markdown_and_git_changes_are_ignored(root):
    with TestClient(create_app(root, watch=True)) as client:
        client.get("/api/notes")
        time.sleep(0.5)
        before = client.get("/api/metrics").json()["counters"].get("watcher_batches", 0)
        (root / "image.png").write_bytes(b"x")
        (root / "scratch.txt").write_text("x")
        git(root, "add", "-A")
        time.sleep(1.2)
        assert client.get("/api/metrics").json()["counters"].get("watcher_batches", 0) == before


def test_watcher_off_by_default_in_tests_and_idle_is_quiet(root):
    client = TestClient(create_app(root, watch=False))
    client.get("/api/notes")
    m = client.get("/api/metrics").json()
    assert m["watcher"] is False and "watcher_batches" not in m["counters"]
    assert m["timings"]["index_rebuild"]["count"] == 1
    client.get("/api/notes")
    client.get("/api/tags")
    assert client.get("/api/metrics").json()["timings"]["index_rebuild"]["count"] == 1  # cached between requests


def test_metrics_shape(root):
    client = TestClient(create_app(root, watch=False))
    client.post("/api/notes", json={"title": "A"})
    m = client.get("/api/metrics").json()
    assert m["timings"]["git_commit"]["count"] == 1
    assert {"uptime_s", "cpu_s", "rss_kb", "threads"} <= set(m["process"])


def install_hook(root, body):
    hook = root / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/bash\n" + body)
    hook.chmod(0o755)


def test_hook_that_reformats_and_restages_is_reflected_in_the_saved_note(root):
    # Same shape as the real notes repo's prettier hook: rewrite staged .md files, then `git add` them.
    install_hook(root, 'for f in $(git diff --cached --name-only --diff-filter=ACM | grep "\\.md$"); do '
                       'sed -i "s/[ \\t]*$//" "$f"; git add "$f"; done\n')
    repo = FileNoteRepository(root)
    saved = repo.create(Note(slug="a", title="A", content="trailing   \nspaces  \n"))
    assert saved.content == "trailing\nspaces\n"
    assert git(root, "status", "--porcelain") == ""  # working tree matches what was committed
    assert len(git(root, "rev-list", "HEAD").split()) == 1


def test_failing_hook_surfaces_an_error_and_keeps_history_intact(root):
    repo = FileNoteRepository(root)
    repo.create(Note(slug="a", title="A", content="one"))
    install_hook(root, 'echo "lint failed" >&2; exit 1\n')
    with pytest.raises(GitError, match="lint failed"):
        repo.update(Note(slug="a", title="A", content="two"))
    assert len(git(root, "rev-list", "HEAD").split()) == 1
    assert git(root, "show", "HEAD:a.md").endswith("one")

import asyncio
import subprocess

import pytest

from src.application.notes.service import PATCH_LIMIT, NoteService
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root, *a):
    subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True)


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


@pytest.fixture
def svc(root):
    return NoteService(FileNoteRepository(root))


async def settle():
    await asyncio.sleep(0.02)  # events are handed to the loop from the calling thread


def drain(sub):
    out = []
    while not sub.queue.empty():
        out.append(sub.queue.get_nowait())
    return out


@pytest.mark.asyncio
async def test_a_save_reaches_a_page_watching_that_note_only(svc):
    svc.create("Alpha", "# Alpha\n\nbody", (), ())
    svc.create("Beta", "# Beta\n\nbody", (), ())
    alpha, beta = svc.feed.subscribe(note="alpha"), svc.feed.subscribe(note="beta")
    saved = svc.update("alpha", content="# Alpha\n\nchanged")
    await settle()
    [event] = drain(alpha)
    assert event["slug"] == "alpha" and event["revision"] == saved.revision and not event["deleted"]
    assert drain(beta) == []


@pytest.mark.asyncio
async def test_an_edit_made_outside_hive_is_announced_with_its_new_revision(svc, root):
    svc.create("Alpha", "# Alpha\n\nbody", (), ())
    sub = svc.feed.subscribe(note="alpha")
    (root / "alpha.md").write_text("# Alpha\n\nedited in an editor\n")
    svc.invalidate(["alpha"])  # what the file watcher does
    await settle()
    [event] = drain(sub)
    assert event["revision"] == svc.get("alpha").revision


@pytest.mark.asyncio
async def test_the_same_change_is_announced_once(svc):
    svc.create("Alpha", "# Alpha\n\nbody", (), ())
    sub = svc.feed.subscribe()
    svc.update("alpha", content="# Alpha\n\nchanged")
    svc.invalidate(["alpha"])  # the watcher seeing the file Hive just wrote
    await settle()
    assert len(drain(sub)) == 1


@pytest.mark.asyncio
async def test_the_task_board_hears_about_tasks_including_one_that_stopped_being_one(svc):
    svc.create("Do it", "# Do it\n", (), ("task",))
    svc.create("Plain", "# Plain\n", (), ())
    board = svc.feed.subscribe(type="task")
    svc.index  # built, as it is whenever a page has loaded
    svc.update("plain", content="# Plain\n\nmore")
    svc.update("do-it", content="# Do it\n\nmore")
    svc.update("do-it", types=())
    await settle()
    assert [e["slug"] for e in drain(board)] == ["do-it", "do-it"]


@pytest.mark.asyncio
async def test_a_deleted_note_is_announced_as_deleted(svc):
    svc.create("Alpha", "# Alpha\n", (), ())
    sub = svc.feed.subscribe(note="alpha")
    svc.delete("alpha")
    await settle()
    [event] = drain(sub)
    assert event["deleted"] is True and event["revision"] is None


@pytest.mark.asyncio
async def test_anything_may_have_changed_resets_everyone(svc):
    sub = svc.feed.subscribe(note="alpha")
    svc.invalidate()  # reindex, the end of a chat run
    for n in range(PATCH_LIMIT + 1):
        svc.invalidate([f"n{n}"])
    svc.invalidate([f"n{n}" for n in range(PATCH_LIMIT + 1)])  # a git pull
    await settle()
    assert drain(sub) == [{"reset": True}, {"reset": True}]


@pytest.mark.asyncio
async def test_a_slow_viewer_is_reset_instead_of_growing_without_limit(svc):
    sub = svc.feed.subscribe()
    for n in range(150):
        svc.feed.publish([{"slug": f"n{n}", "revision": "r", "types": []}])
    await settle()
    assert sub.queue.qsize() <= 100 and {"reset": True} in drain(sub)


@pytest.mark.asyncio
async def test_nothing_is_read_while_nobody_listens(svc, monkeypatch):
    svc.create("Alpha", "# Alpha\n", (), ())
    monkeypatch.setattr(svc.repo, "get", lambda slug: pytest.fail("read for nobody"))
    svc.invalidate(["alpha"])
    sub = svc.feed.subscribe()
    sub.close()
    svc.invalidate(["alpha"])

import subprocess

import pytest

from src.application.chat.tools import TOOLS, NotesTools, ToolError
from src.application.notes.service import NoteService
from src.infrastructure.fs_notes.repository import FileNoteRepository


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


@pytest.fixture
def notes(root):
    service = NoteService(FileNoteRepository(root))
    service.create("Home network", "The wifi password is hunter2.\nRouter: Unifi.", tags=("home",), types=("note",))
    service.create("Gardening", "Tomatoes in May.")
    return service


@pytest.fixture
def tools(notes):
    return NotesTools(notes)


def test_every_tool_has_a_schema_and_a_handler(tools):
    assert len({t["name"] for t in TOOLS}) == len(TOOLS)
    for tool in TOOLS:
        assert tool["inputSchema"]["type"] == "object" and tool["description"]
        assert hasattr(tools, "_" + tool["name"])


def test_search_finds_text_and_shows_where(tools):
    out = tools.call("search_notes", {"query": "wifi"})
    assert "slug: home-network" in out and "wifi password" in out and "gardening" not in out
    assert "No notes match" in tools.call("search_notes", {"query": "zzz"})


def test_read_and_list_and_backlinks(tools, notes):
    assert "tags: home" in tools.call("read_note", {"slug": "home-network"}) and "hunter2" in tools.call("read_note", {"slug": "home-network"})
    assert tools.call("list_notes", {"tag": "home"}).strip() == "- home-network: Home network"
    assert "gardening" in tools.call("list_notes", {})
    notes.create("Index", "see [[Gardening]]")
    assert "index" in tools.call("backlinks", {"slug": "gardening"})
    with pytest.raises(ToolError):
        tools.call("read_note", {"slug": "nope"})


def test_edit_replaces_one_passage_in_one_commit_and_records_the_slug(tools, notes, root):
    before = git(root, "rev-list", "--count", "HEAD")
    assert "Edited home-network" in tools.call("edit_note", {"slug": "home-network", "old": "hunter2", "new": "swordfish"})
    assert "swordfish" in notes.get("home-network").content and tools.changed == ["home-network"]
    assert int(git(root, "rev-list", "--count", "HEAD")) == int(before) + 1


def test_edit_refuses_a_passage_that_is_missing_or_ambiguous(tools, notes):
    with pytest.raises(ToolError, match="not found"):
        tools.call("edit_note", {"slug": "home-network", "old": "nothing here", "new": "x"})
    notes.create("Twice", "a a")
    with pytest.raises(ToolError, match="2 times"):
        tools.call("edit_note", {"slug": "twice", "old": "a", "new": "b"})
    with pytest.raises(ToolError, match="empty"):
        tools.call("edit_note", {"slug": "twice", "old": "", "new": "b"})
    assert tools.changed == []


def test_editing_the_heading_renames_the_note_through_the_service(tools, notes, root):
    notes.create("Index", "see [[home-network]]")
    out = tools.call("edit_note", {"slug": "home-network", "old": "# Home network", "new": "# Home lab"})
    assert "renamed to home-lab" in out and (root / "home-lab.md").exists() and not (root / "home-network.md").exists()
    assert tools.changed == ["home-network", "home-lab"]


def test_append_create_rewrite_and_properties(tools, notes):
    tools.call("append_to_note", {"slug": "gardening", "text": "Beans in June."})
    assert notes.get("gardening").content.rstrip().endswith("Tomatoes in May.\n\nBeans in June.")
    assert "Created plan" in tools.call("create_note", {"title": "Plan", "content": "Step one", "tags": ["work"], "types": ["task"]})
    assert notes.get("plan").tags == ("work",)
    tools.call("rewrite_note", {"slug": "plan", "content": "# Plan\n\nNew text"})
    assert notes.get("plan").content.endswith("New text")
    tools.call("set_note_properties", {"slug": "plan", "status": "DONE", "priority": "must"})
    plan = notes.get("plan")
    assert plan.status == "DONE" and plan.priority == "must"
    assert tools.changed == ["gardening", "plan"]


def test_bad_calls_are_explained_to_the_model(tools):
    with pytest.raises(ToolError, match="Unknown tool"):
        tools.call("delete_everything", {})
    with pytest.raises(ToolError, match="Unknown tool"):
        tools.call("__init__", {})
    with pytest.raises(ToolError, match="Bad arguments"):
        tools.call("read_note", {"wrong": 1})
    with pytest.raises(ToolError, match="status must be"):
        tools.call("set_note_properties", {"slug": "gardening", "status": "MAYBE"})
    with pytest.raises(ToolError, match="priority must be"):
        tools.call("set_note_properties", {"slug": "gardening", "priority": "urgent"})

import subprocess

import pytest

from src.application.chat.service import ChatService, build_prompt, instructions
from src.application.chat.tools import NotesTools
from src.application.notes.service import NoteService
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.git.client import GitClient


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    return tmp_path


class Scripted:
    """Stands in for Codex: records the prompt and edits through the same tools Codex would call."""

    def __init__(self, notes, script=None, events=()):
        self.notes, self.script, self.events, self.prompt = notes, script, list(events), None

    def run(self, prompt):
        self.prompt = prompt
        yield {"type": "message", "text": "Working."}
        if self.script:
            self.script(NotesTools(self.notes))
        yield from self.events
        yield {"type": "done", "usage": {}}


def make(root, script=None):
    notes = NoteService(FileNoteRepository(root))
    notes.create("Alpha", "first")
    runner = Scripted(notes, script)
    return ChatService(runner, notes, GitClient(root), root), runner, notes


def test_the_prompt_has_the_rules_the_vault_instructions_the_recent_turns_and_the_question():
    turns = [{"role": "user", "content": f"q{i}"} if i % 2 == 0 else {"role": "assistant", "content": f"a{i}"} for i in range(30)] + [{"role": "user", "content": "last?"}]
    prompt = build_prompt(turns, "Always answer in French.")
    assert "search_notes" in prompt and "<vault_instructions>\nAlways answer in French." in prompt
    assert prompt.endswith("Question from the user (answer this one):\nlast?")
    assert "q0" not in prompt and "a29" in prompt  # only the last turns are kept
    assert "vault_instructions" not in build_prompt([{"role": "user", "content": "hi"}]) and "Conversation so far" not in build_prompt([{"role": "user", "content": "hi"}])


def test_vault_instructions_come_from_agents_md_or_agent_md(root):
    assert instructions(root) == ""
    (root / "agent.md").write_text("Use short answers.\n")
    assert instructions(root) == "Use short answers."
    (root / "AGENTS.md").write_text("x" * 30_000)
    assert instructions(root).endswith("[instructions cut]") and instructions(root).startswith("xxx")


def test_the_vault_instructions_reach_codex(root):
    (root / "AGENTS.md").write_text("Log meetings as type: meeting.")
    service, runner, _ = make(root)
    list(service.stream([{"role": "user", "content": "hello"}]))
    assert "Log meetings as type: meeting." in runner.prompt


def test_a_question_that_changes_nothing_reports_nothing_changed(root):
    service, _, _ = make(root)
    events = list(service.stream([{"role": "user", "content": "what is alpha?"}]))
    assert [e["type"] for e in events] == ["message", "done"]


def test_notes_saved_during_the_run_are_reported_even_when_renamed(root):
    def script(tools):
        tools.call("append_to_note", {"slug": "alpha", "text": "more"})
        tools.call("create_note", {"title": "Beta", "content": "b"})
        tools.call("edit_note", {"slug": "beta", "old": "# Beta", "new": "# Gamma"})

    service, _, _ = make(root, script)
    events = list(service.stream([{"role": "user", "content": "do it"}]))
    assert events[-1] == {"type": "changed", "notes": [{"slug": "alpha", "title": "Alpha"}, {"slug": "gamma", "title": "Gamma"}]}


def test_the_index_is_refreshed_after_a_run(root):
    service, _, notes = make(root)
    assert [n.slug for n in notes.list()] == ["alpha"]
    (root / "outside.md").write_text("# Outside\n")
    list(service.stream([{"role": "user", "content": "x"}]))
    assert {n.slug for n in notes.list()} == {"alpha", "outside"}


def test_bad_requests_and_a_missing_codex_are_errors_not_runs(root):
    service, runner, notes = make(root)
    for messages in ([], [{"role": "assistant", "content": "hi"}], [{"role": "user", "content": "  "}]):
        assert list(service.stream(messages))[0]["type"] == "error"
    assert runner.prompt is None
    nobody = ChatService(None, notes, GitClient(root), root)
    assert not nobody.available and "not available" in list(nobody.stream([{"role": "user", "content": "x"}]))[0]["message"]

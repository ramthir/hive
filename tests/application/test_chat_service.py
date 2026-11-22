import subprocess

import pytest

from src.application.chat.service import ChatService, build_prompt
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

    def __init__(self, notes, script=None, events=(), resume_fails=False):
        self.notes, self.script, self.events, self.prompt = notes, script, list(events), None
        self.resume_fails, self.runs = resume_fails, []

    def run(self, prompt, session=None):
        self.prompt = prompt
        self.runs.append((session, prompt))
        if session and self.resume_fails:
            yield {"type": "error", "message": "no such session"}
            return
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


def test_the_prompt_has_the_shell_rules_the_recent_turns_and_the_question():
    turns = [{"role": "user", "content": f"q{i}"} if i % 2 == 0 else {"role": "assistant", "content": f"a{i}"} for i in range(30)] + [{"role": "user", "content": "last?"}]
    prompt = build_prompt(turns)
    assert "shell commands" in prompt and "AGENTS.md" in prompt and "git add -- <files>" in prompt and "Never push" in prompt
    assert "search_notes" not in prompt
    assert prompt.endswith("Question from the user (answer this one):\nlast?")
    assert "q0" not in prompt and "a29" in prompt  # only the last turns are kept
    assert "Conversation so far" not in build_prompt([{"role": "user", "content": "hi"}])


def test_the_prompt_knows_today():
    from datetime import date
    assert "Today is Saturday 2026-11-21." in build_prompt([{"role": "user", "content": "log 1h on tax"}], date(2026, 11, 21))
    assert "Today is" not in build_prompt([{"role": "user", "content": "x"}])


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


SESSION = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b"
TURNS = [{"role": "user", "content": "first q"}, {"role": "assistant", "content": "first a"}, {"role": "user", "content": "and then?"}]


def test_a_resumed_session_gets_only_the_question_and_today(root):
    service, runner, _ = make(root)
    list(service.stream(TURNS, SESSION))
    (session, prompt), = runner.runs
    assert session == SESSION and prompt.endswith("Question from the user (answer this one):\nand then?")
    assert "Today is" in prompt and "first q" not in prompt and "AGENTS.md" not in prompt


def test_a_session_that_cannot_be_resumed_starts_a_new_one_with_the_turns_replayed(root):
    service, runner, notes = make(root)
    runner.resume_fails = True
    events = list(service.stream(TURNS, SESSION))
    assert [r[0] for r in runner.runs] == [SESSION, None]
    assert "User: first q" in runner.runs[1][1] and "shell commands" in runner.runs[1][1]
    assert [e["type"] for e in events] == ["message", "done"]  # the failed resume is not shown


def test_the_server_keeps_the_session_and_new_chat_forgets_it(root, tmp_path):
    from src.infrastructure.agents.sessions import SessionStore
    SID = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b"
    notes = NoteService(FileNoteRepository(root))
    notes.create("Alpha", "first")
    runner = Scripted(notes, events=[{"type": "session", "id": SID}])
    store = SessionStore(tmp_path / "sessions.json")
    chat = ChatService(runner, notes, GitClient(root), root, store)
    ask = [{"role": "user", "content": "hi"}]
    list(chat.stream(ask))
    assert store.get("chat") == SID and runner.runs[0][0] is None
    list(chat.stream(ask))  # another browser, no session sent: still the same Codex session
    assert runner.runs[1][0] == SID
    chat.reset()
    list(chat.stream(ask))
    assert runner.runs[2][0] is None

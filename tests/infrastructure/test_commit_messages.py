"""Better commit messages: Codex reads the diff and the commit message is replaced in the background."""
import subprocess
from datetime import date
from pathlib import Path

import pytest

from src.domain.notes.entities import Note
from src.infrastructure.agents.codex import CodexCommitMessages, clean_subject
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.git.client import GitClient
from src.infrastructure.git.rewording import CommitRewriter


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


class Writer:
    def __init__(self, answer="doc: add storage options"):
        self.answer, self.calls = answer, []

    def describe(self, title, subject, diff):
        self.calls.append((title, subject, diff))
        return self.answer


@pytest.mark.parametrize("raw, expected", [
    ("doc: add storage options", "doc: add storage options"),
    ('"doc: add storage options."\n\nbody', "doc: add storage options"),
    ("`add storage options`", "doc: add storage options"),  # no prefix: doc: is added
    ("fix(notes): keep tags", "fix(notes): keep tags"),
    ("", None),
    ("doc: " + "x" * 80, None),  # too long for a subject
])
def test_clean_subject(raw, expected):
    assert clean_subject(raw) == expected


def fake_codex(tmp_path, body):
    """A stand-in `codex`: records its arguments and standard input, then runs `body` ($OUT is the -o file)."""
    script = tmp_path / "codex"
    script.write_text(f'''#!/bin/bash
echo "$@" > "{tmp_path}/args.txt"
cat > "{tmp_path}/stdin.txt"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUT="$2"; shift; done
{body}
''')
    script.chmod(0o755)
    return str(script)


def test_codex_runs_one_shot_read_only_with_the_diff_on_stdin(tmp_path):
    program = fake_codex(tmp_path, 'echo "doc: add storage options" > "$OUT"')
    message = CodexCommitMessages(program, model="m1", effort="medium").describe("Home network", "doc: update Home network", "+Storage: NAS\n")
    assert message == "doc: add storage options"
    args = (tmp_path / "args.txt").read_text()
    for flag in ("exec", "--sandbox read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--model m1", 'model_reasoning_effort="medium"'):
        assert flag in args
    assert "--ephemeral" not in args  # Codex keeps the session, so ccusage counts the tokens
    assert args.rstrip().endswith("-")  # the prompt comes on standard input
    prompt = (tmp_path / "stdin.txt").read_text()
    assert "+Storage: NAS" in prompt and "Home network" in prompt and "doc: update Home network" in prompt


def test_codex_gives_none_when_it_fails_or_answers_nothing(tmp_path):
    assert CodexCommitMessages(fake_codex(tmp_path, "exit 3")).describe("T", "s", "+x\n") is None
    assert CodexCommitMessages(fake_codex(tmp_path, ': > "$OUT"')).describe("T", "s", "+x\n") is None
    assert CodexCommitMessages(str(tmp_path / "missing")).describe("T", "s", "+x\n") is None
    assert CodexCommitMessages(fake_codex(tmp_path, "sleep 5"), timeout=0.2).describe("T", "s", "+x\n") is None
    assert CodexCommitMessages(fake_codex(tmp_path, 'echo "doc: x" > "$OUT"')).describe("T", "s", "  \n") is None  # nothing to describe


def commit_file(root, name="a.md", text="one\n", message="doc: update A"):
    (root / name).write_text(text)
    git(root, "add", name)
    git(root, "commit", "-qm", message)
    return git(root, "rev-parse", "HEAD").strip()


def test_reword_changes_only_the_message(root):
    sha = commit_file(root)
    (root / "other.md").write_text("staged\n")
    git(root, "add", "other.md")  # an unrelated staged file stays staged
    (root / "dirty.md").write_text("dirty\n")
    before = git(root, "log", "-1", "--format=%T|%an|%aI|%P", sha)
    assert GitClient(root).reword(sha, "doc: add a first line")
    assert git(root, "log", "-1", "--format=%s") .strip() == "doc: add a first line"
    assert git(root, "log", "-1", "--format=%T|%an|%aI|%P").strip() == before.strip()
    assert git(root, "rev-parse", "HEAD").strip() != sha
    assert git(root, "diff", "--cached", "--name-only").split() == ["other.md"]
    assert (root / "dirty.md").read_text() == "dirty\n"
    assert len(git(root, "rev-list", "HEAD").split()) == 2


def test_reword_leaves_a_commit_that_is_not_the_tip_or_was_pushed(root, tmp_path_factory):
    first = commit_file(root)
    commit_file(root, "b.md", "two\n", "doc: update B")
    assert not GitClient(root).reword(first, "doc: better")  # another commit landed
    tip = git(root, "rev-parse", "HEAD").strip()
    remote = tmp_path_factory.mktemp("remote")
    git(remote, "init", "-q", "--bare")
    git(root, "remote", "add", "origin", str(remote))
    git(root, "push", "-q", "origin", "main")
    assert not GitClient(root).reword(tip, "doc: better")  # already on the server
    assert git(root, "rev-parse", "HEAD").strip() == tip


def test_a_saved_note_gets_the_message_derived_from_its_diff(root):
    client = GitClient(root)
    writer = Writer("doc: add storage options to Home network")
    rewriter = CommitRewriter(client, writer)
    repo = FileNoteRepository(root, client, today=lambda: date(2026, 11, 20), after_commit=rewriter.submit)
    note = repo.create(Note(slug="home", title="Home", content="# Home\n"))
    rewriter.wait()
    repo.update(Note(slug="home", title="Home", content="# Home\n\nStorage: NAS\n", created=note.created))
    rewriter.wait()
    assert git(root, "log", "--format=%s", "-3").splitlines()[:2] == ["doc: add storage options to Home network"] * 2
    title, subject, diff = writer.calls[-1]
    assert (title, subject) == ("Home", "doc: update Home") and "+Storage: NAS" in diff
    rewriter.stop()


def test_without_a_better_message_or_after_a_newer_commit_the_plain_one_stays(root):
    client = GitClient(root)
    writer = Writer(answer=None)
    rewriter = CommitRewriter(client, writer)
    repo = FileNoteRepository(root, client, today=lambda: date(2026, 11, 20), after_commit=rewriter.submit)
    repo.create(Note(slug="home", title="Home", content="# Home\n"))
    rewriter.wait()
    assert git(root, "log", "-1", "--format=%s").strip() == "doc: add Home"  # the writer had nothing
    writer.answer = "doc: nicer"
    first = git(root, "rev-parse", "HEAD").strip()
    commit_file(root, "x.md", "x\n", "doc: someone else")  # lands before the job runs
    rewriter.submit(first, "Home", ["home.md"])
    rewriter.wait()
    assert git(root, "log", "-1", "--format=%s").strip() == "doc: someone else"
    rewriter.stop()


def test_the_app_only_rewrites_messages_when_asked(root, monkeypatch, tmp_path):
    from src.api.main import commit_rewriter
    client = GitClient(root)
    monkeypatch.delenv("HIVE_COMMIT_MESSAGES", raising=False)
    assert commit_rewriter(client, None) is None  # off by default: the diff would leave the machine
    monkeypatch.setenv("HIVE_COMMIT_MESSAGES", "codex")
    monkeypatch.setenv("HIVE_CODEX", str(tmp_path / "missing"))
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert commit_rewriter(client, None) is None  # asked for, but there is no codex
    monkeypatch.setenv("HIVE_CODEX", fake_codex(tmp_path, "true"))
    rewriter = commit_rewriter(client, None)
    assert isinstance(rewriter, CommitRewriter)
    rewriter.stop()

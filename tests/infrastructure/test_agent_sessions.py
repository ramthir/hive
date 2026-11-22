import json
import sys
import stat

from src.infrastructure.agents.codex import CodexCommitMessages
from src.infrastructure.agents.sessions import SessionStore

A, B = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b", "11111111-2222-3333-4444-555555555555"


def test_the_store_keeps_ids_on_disk_and_ignores_junk(tmp_path):
    path = tmp_path / "state" / "s.json"
    store = SessionStore(path)
    assert store.get("chat") is None
    store.set("chat", A)
    store.set("commit", B)
    assert SessionStore(path).get("chat") == A and SessionStore(path).get("commit") == B  # survives a restart
    store.set("chat", "not-a-uuid")
    assert store.get("chat") is None and store.get("commit") == B
    path.write_text("{broken")
    assert store.get("commit") is None


def fake_codex(tmp_path, body: str) -> str:
    path = tmp_path / "codex"
    path.write_text(f"#!{sys.executable}\nimport sys, json\nargs = sys.argv[1:]\nout = args[args.index('-o') + 1]\nsys.stdin.read()\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_commit_messages_continue_one_saved_session_in_the_notes(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    log = tmp_path / "calls.jsonl"
    program = fake_codex(tmp_path, f"import os\nopen({str(log)!r}, 'a').write(json.dumps({{'args': args, 'cwd': os.getcwd()}}) + '\\n')\n"
                                   f"print(json.dumps({{'type': 'thread.started', 'thread_id': {A!r}}}))\nopen(out, 'w').write('doc: add storage')")
    sessions = SessionStore(tmp_path / "s.json")
    writer = CodexCommitMessages(program, notes_dir=notes, sessions=sessions)
    assert writer.describe("T", "doc: update T", "+x\n") == "doc: add storage"
    assert writer.describe("T", "doc: update T", "+y\n") == "doc: add storage"
    first, second = [json.loads(l) for l in log.read_text().splitlines()]
    assert sessions.get("commit") == A
    for call in (first, second):
        assert "--ephemeral" not in call["args"] and call["cwd"] == str(notes.resolve())
    assert "resume" not in first["args"] and "resume" in second["args"] and A in second["args"]


def test_a_session_that_cannot_be_resumed_starts_a_new_one(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    program = fake_codex(tmp_path, f"if 'resume' in args: sys.exit(1)\nprint(json.dumps({{'type': 'thread.started', 'thread_id': {B!r}}}))\nopen(out, 'w').write('doc: x')")
    sessions = SessionStore(tmp_path / "s.json")
    sessions.set("commit", A)
    assert CodexCommitMessages(program, notes_dir=notes, sessions=sessions).describe("T", "s", "+x\n") == "doc: x"
    assert sessions.get("commit") == B


def test_the_commit_session_starts_anew_each_month(tmp_path):
    from datetime import date
    notes = tmp_path / "notes"
    notes.mkdir()
    log = tmp_path / "calls.jsonl"
    ids = iter([A, B, A])
    program = fake_codex(tmp_path, f"import os\nopen({str(log)!r}, 'a').write(json.dumps(args) + '\\n')\n"
                                   f"print(json.dumps({{'type': 'thread.started', 'thread_id': {A!r} if 'resume' in args else open({str(tmp_path / 'n')!r}, 'a+').read() or {B!r}}}))\nopen(out, 'w').write('doc: x')")
    sessions = SessionStore(tmp_path / "s.json")
    day = [date(2026, 11, 20)]
    writer = CodexCommitMessages(program, notes_dir=notes, sessions=sessions, today=lambda: day[0])
    writer.describe("T", "s", "+1\n")
    assert sessions.get("commit") == B and sessions.tag("commit") == "2026-11"
    day[0] = date(2026, 11, 30)
    writer.describe("T", "s", "+2\n")  # same month: resumed
    day[0] = date(2026, 12, 1)
    writer.describe("T", "s", "+3\n")  # new month: a new session
    calls = [json.loads(l) for l in log.read_text().splitlines()]
    assert ["resume" in c for c in calls] == [False, True, False]
    assert sessions.tag("commit") == "2026-12"


def test_an_id_without_a_month_is_rotated_once(tmp_path):
    from datetime import date
    notes = tmp_path / "notes"
    notes.mkdir()
    program = fake_codex(tmp_path, f"print(json.dumps({{'type': 'thread.started', 'thread_id': {B!r}}}))\nassert 'resume' not in args\nopen(out, 'w').write('doc: x')")
    sessions = SessionStore(tmp_path / "s.json")
    sessions.set("commit", A)
    assert CodexCommitMessages(program, notes_dir=notes, sessions=sessions, today=lambda: date(2026, 11, 1)).describe("T", "s", "+x\n") == "doc: x"
    assert sessions.get("commit") == B and sessions.tag("commit") == "2026-11"

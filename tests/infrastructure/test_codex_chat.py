import json
import stat
import sys
from pathlib import Path

from src.infrastructure.agents.codex_chat import CodexChat, build_args

SESSION = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b"
LINES = [
    '2026-11-21T12:29:42Z ERROR codex_core::tools::router: a log line',
    json.dumps({"type": "item.completed", "item": {"id": "a", "type": "agent_message", "text": "Looking."}}),
    json.dumps({"type": "item.started", "item": {"id": "b", "type": "mcp_tool_call", "tool": "read_note", "arguments": {"slug": "x"}}}),
    json.dumps({"type": "item.completed", "item": {"id": "b", "type": "mcp_tool_call", "tool": "read_note", "arguments": {"slug": "x"}, "status": "completed"}}),
    json.dumps({"type": "item.completed", "item": {"id": "c", "type": "agent_message", "text": "Answer."}}),
    json.dumps({"type": "turn.completed", "usage": {}}),
]


def fake(tmp_path: Path, body: str) -> str:
    path = tmp_path / "codex"
    path.write_text(f"#!{sys.executable}\nimport sys\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_the_command_has_no_shell_and_only_the_notes_tools(tmp_path):
    args = build_args("/bin/codex", "/scratch", tmp_path / "notes", python="/venv/bin/python", model="m", effort="low")
    assert args[:3] == ["/bin/codex", "exec", "--json"] and args[-1] == "-"
    joined = " ".join(args)
    assert "--ephemeral" not in args  # Codex keeps the session: ccusage counts it and the next question resumes it
    assert "resume" not in args
    for flag in ("--ignore-user-config", "--ignore-rules", "--disable shell_tool", "--disable unified_exec", "--sandbox read-only", "-C /scratch", "--model m"):
        assert flag in joined
    assert 'mcp_servers.hive.command="/venv/bin/python"' in args
    assert any(a.startswith("mcp_servers.hive.env={NOTES_DIR=") and str(tmp_path / "notes") in a for a in args)
    assert 'model_reasoning_effort="low"' in args


def test_events_stream_in_order_and_the_prompt_arrives_on_stdin(tmp_path):
    program = fake(tmp_path, f"prompt = sys.stdin.read()\nassert 'Question' in prompt\nfor l in {LINES!r}: print(l, flush=True)")
    events = list(CodexChat(program, tmp_path).run("Question"))
    assert [e["type"] for e in events] == ["message", "step", "step", "message", "done"]
    assert events[-2]["text"] == "Answer."


def test_exiting_without_a_finished_turn_is_an_error(tmp_path):
    events = list(CodexChat(fake(tmp_path, "sys.stdin.read()\nprint('nothing')"), tmp_path).run("q"))
    assert events == [{"type": "error", "message": "Codex stopped before answering."}]


def test_a_stuck_codex_is_stopped_at_the_timeout(tmp_path):
    events = list(CodexChat(fake(tmp_path, "import time\nsys.stdin.read()\ntime.sleep(60)"), tmp_path, timeout=0.5).run("q"))
    assert events == [{"type": "error", "message": "Codex took too long and was stopped."}]


def test_a_missing_program_is_reported(tmp_path):
    assert list(CodexChat(str(tmp_path / "nope"), tmp_path).run("q"))[0]["type"] == "error"


def test_a_resumed_session_keeps_the_same_limits(tmp_path):
    args = build_args("/bin/codex", "/scratch", tmp_path / "notes", python="/venv/bin/python", model="m", session=SESSION)
    assert args[:4] == ["/bin/codex", "exec", "resume", "--json"] and args[-2:] == [SESSION, "-"]
    joined = " ".join(args)
    for flag in ("--ignore-user-config", "--ignore-rules", "--disable shell_tool", "--disable unified_exec", '-c sandbox_mode="read-only"', "--model m"):
        assert flag in joined
    assert "--sandbox" not in args and "-C" not in args and "--ephemeral" not in args  # not options of `exec resume`
    assert 'mcp_servers.hive.command="/venv/bin/python"' in args


def test_the_session_id_is_reported_and_the_run_resumes_it(tmp_path):
    body = ("import json\nprint(json.dumps({'type': 'thread.started', 'thread_id': 'abc'}))\n"
            "print(json.dumps({'type': 'item.completed', 'item': {'id': 'a', 'type': 'agent_message', 'text': ' '.join(sys.argv[1:4])}}))\n"
            "sys.stdin.read()\nprint('{\"type\":\"turn.completed\"}')")
    program = fake(tmp_path, body)
    events = list(CodexChat(program, tmp_path, scratch=tmp_path / "scratch").run("q"))
    assert events[0] == {"type": "session", "id": "abc"} and events[1]["text"] == "exec --json --sandbox"
    resumed = list(CodexChat(program, tmp_path, scratch=tmp_path / "scratch").run("q", SESSION))
    assert resumed[1]["text"] == "exec resume --json"


def test_every_run_works_in_the_same_empty_folder_which_is_kept(tmp_path):
    program = fake(tmp_path, "import os\nsys.stdin.read()\nprint(json_dumps := '{\"type\":\"item.completed\",\"item\":{\"id\":\"a\",\"type\":\"agent_message\",\"text\":\"' + os.getcwd() + '\"}}')\nprint('{\"type\":\"turn.completed\"}')")
    scratch = tmp_path / "scratch"
    chat = CodexChat(program, tmp_path, scratch=scratch)
    first = [e for e in chat.run("q") if e["type"] == "message"][0]["text"]
    second = [e for e in chat.run("q") if e["type"] == "message"][0]["text"]
    assert Path(first).resolve() == Path(second).resolve() == scratch.resolve()
    assert scratch.is_dir() and list(scratch.iterdir()) == []

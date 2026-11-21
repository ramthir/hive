import json
import stat
import sys
from pathlib import Path

from src.infrastructure.agents.codex_chat import CodexChat, build_args

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


def test_the_command_has_no_shell_no_session_and_only_the_notes_tools(tmp_path):
    args = build_args("/bin/codex", "/scratch", tmp_path / "notes", python="/venv/bin/python", model="m", effort="low")
    assert args[:3] == ["/bin/codex", "exec", "--json"] and args[-1] == "-"
    joined = " ".join(args)
    for flag in ("--ephemeral", "--ignore-user-config", "--ignore-rules", "--disable shell_tool", "--disable unified_exec", "--sandbox read-only", "-C /scratch", "--model m"):
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


def test_the_scratch_folder_is_removed(tmp_path, monkeypatch):
    import tempfile
    made = []
    real = tempfile.mkdtemp
    monkeypatch.setattr(tempfile, "mkdtemp", lambda **kw: made.append(real(**kw)) or made[-1])
    program = fake(tmp_path, "import os\nsys.stdin.read()\nprint('{\"type\":\"turn.completed\"}')")
    list(CodexChat(program, tmp_path).run("q"))
    assert made and not Path(made[0]).exists()

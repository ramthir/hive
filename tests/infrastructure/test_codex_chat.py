import json
import stat
import sys
from pathlib import Path

from src.infrastructure.agents.codex_chat import CodexChat, build_args

SESSION = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b"
LINES = [
    '2026-11-21T12:29:42Z ERROR codex_core::tools::router: a log line',
    json.dumps({"type": "item.completed", "item": {"id": "a", "type": "agent_message", "text": "Looking."}}),
    json.dumps({"type": "item.started", "item": {"id": "b", "type": "command_execution", "command": "cat x.md", "status": "in_progress"}}),
    json.dumps({"type": "item.completed", "item": {"id": "b", "type": "command_execution", "command": "cat x.md", "status": "completed", "exit_code": 0}}),
    json.dumps({"type": "item.completed", "item": {"id": "c", "type": "agent_message", "text": "Answer."}}),
    json.dumps({"type": "turn.completed", "usage": {}}),
]


def fake(tmp_path: Path, body: str) -> str:
    path = tmp_path / "codex"
    path.write_text(f"#!{sys.executable}\nimport sys\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_codex_works_in_the_notes_with_its_own_shell_and_no_tools(tmp_path):
    notes = tmp_path / "notes"
    args = build_args("/bin/codex", notes, model="m", effort="low")
    assert args[:3] == ["/bin/codex", "exec", "--json"] and args[-1] == "-" and "resume" not in args
    joined = " ".join(args)
    assert f"-C {notes}" in joined and "--dangerously-bypass-approvals-and-sandbox" in args
    assert "--ephemeral" not in args  # Codex keeps the session: ccusage counts it and the next question resumes it
    for flag in ("--ignore-user-config", "--ignore-rules", "--model m"):
        assert flag in joined
    assert "mcp_servers" not in joined and "shell_tool" not in joined and "--sandbox" not in args
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


def test_a_resumed_session_runs_in_the_same_folder_unsandboxed(tmp_path):
    args = build_args("/bin/codex", tmp_path / "notes", model="m", session=SESSION)
    assert args[:4] == ["/bin/codex", "exec", "resume", "--json"] and args[-2:] == [SESSION, "-"]
    assert "--dangerously-bypass-approvals-and-sandbox" in args and "-C" not in args and "--ephemeral" not in args  # -C is not an option of `exec resume`


def test_the_session_id_is_reported_and_the_run_resumes_it(tmp_path):
    body = ("import json\nprint(json.dumps({'type': 'thread.started', 'thread_id': 'abc'}))\n"
            "print(json.dumps({'type': 'item.completed', 'item': {'id': 'a', 'type': 'agent_message', 'text': ' '.join(sys.argv[1:3])}}))\n"
            "sys.stdin.read()\nprint('{\"type\":\"turn.completed\"}')")
    program = fake(tmp_path, body)
    events = list(CodexChat(program, tmp_path).run("q"))
    assert events[0] == {"type": "session", "id": "abc"} and events[1]["text"] == "exec --json"
    assert list(CodexChat(program, tmp_path).run("q", SESSION))[1]["text"] == "exec resume"


def test_every_run_works_in_the_notes_folder(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    program = fake(tmp_path, "import os\nsys.stdin.read()\nprint('{\"type\":\"item.completed\",\"item\":{\"id\":\"a\",\"type\":\"agent_message\",\"text\":\"' + os.getcwd() + '\"}}')\nprint('{\"type\":\"turn.completed\"}')")
    chat = CodexChat(program, notes)
    for session in (None, SESSION):
        assert Path([e for e in chat.run("q", session) if e["type"] == "message"][0]["text"]).resolve() == notes.resolve()


def agy_fake(tmp_path: Path, body: str) -> str:
    path = tmp_path / "agy"
    path.write_text(f"#!{sys.executable}\nimport sys, json, os\nargs = sys.argv[1:]\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_agy_chat_runs_in_the_notes_with_the_prompt_as_an_argument_and_resumes(tmp_path):
    from src.infrastructure.agents.agy import AgyChat
    notes = tmp_path / "notes"
    notes.mkdir()
    body = ("print(json.dumps({'event': 'init', 'conversation_id': 'conv-1'}))\n"
            "print(json.dumps({'event': 'step_update', 'step_update': {'step_index': 1, 'state': 'DONE', 'step_type': 'agent_response', 'text_delta': json.dumps(args) + ' ' + os.getcwd()}}))\n"
            "print(json.dumps({'event': 'result', 'result': {'status': 'SUCCESS', 'usage': {}}}))")
    chat = AgyChat(agy_fake(tmp_path, body), notes, model="m", effort="low")
    events = list(chat.run("Question?"))
    assert [e["type"] for e in events] == ["session", "message", "done"] and events[0]["id"] == "conv-1"
    args, cwd = json.loads(events[1]["text"].rsplit(" ", 1)[0]), events[1]["text"].rsplit(" ", 1)[1]
    assert args[0] == "--print=Question?" and "--dangerously-skip-permissions" in args and "--conversation" not in args
    assert args[args.index("--output-format") + 1] == "stream-json" and args[args.index("--model") + 1] == "m" and args[args.index("--effort") + 1] == "low"
    assert Path(cwd).resolve() == notes.resolve()
    resumed = json.loads(list(chat.run("again", "conv-1"))[1]["text"].rsplit(" ", 1)[0])
    assert resumed[resumed.index("--conversation") + 1] == "conv-1"
    assert chat.session_key == "chat-agy" and "Antigravity" in chat.missing


def test_agy_chat_cuts_a_prompt_too_long_for_an_argument(tmp_path):
    from src.infrastructure.agents.agy import MAX_PROMPT_CHARS, fit
    assert fit("short") == "short"
    cut = fit("a" * 200_000)
    assert len(cut) < MAX_PROMPT_CHARS + 20 and "[…cut…]" in cut


def test_agy_not_finishing_is_an_error_naming_antigravity(tmp_path):
    from src.infrastructure.agents.agy import AgyChat
    events = list(AgyChat(agy_fake(tmp_path, "print('nothing')"), tmp_path).run("q"))
    assert events == [{"type": "error", "message": "Antigravity stopped before answering."}]


def claude_fake(tmp_path: Path, body: str) -> str:
    path = tmp_path / "claude"
    path.write_text(f"#!{sys.executable}\nimport sys, json, os\nargs = sys.argv[1:]\nprompt = sys.stdin.read()\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_claude_chat_runs_in_the_notes_with_the_prompt_on_stdin_and_resumes(tmp_path):
    from src.infrastructure.agents.claude import ClaudeChat
    notes = tmp_path / "notes"
    notes.mkdir()
    body = ("print(json.dumps({'type': 'system', 'subtype': 'init', 'session_id': 'sess-1'}))\n"
            "print(json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': json.dumps(args) + ' ' + os.getcwd() + ' ' + prompt}]}}))\n"
            "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'usage': {}}))")
    chat = ClaudeChat(claude_fake(tmp_path, body), notes, model="m", effort="low")
    events = list(chat.run("Question?"))
    assert [e["type"] for e in events] == ["session", "message", "done"] and events[0]["id"] == "sess-1"
    args, cwd, prompt = events[1]["text"].rsplit(" ", 2)[0], events[1]["text"].rsplit(" ", 2)[1], events[1]["text"].rsplit(" ", 2)[2]
    args = json.loads(args)
    assert "--dangerously-skip-permissions" in args and "--resume" not in args and prompt == "Question?" and "Question?" not in args
    assert args[args.index("--output-format") + 1] == "stream-json" and "--verbose" in args
    assert args[args.index("--model") + 1] == "m" and args[args.index("--effort") + 1] == "low"
    assert Path(cwd).resolve() == notes.resolve()
    resumed = json.loads(list(chat.run("again", "sess-1"))[1]["text"].rsplit(" ", 2)[0])
    assert resumed[resumed.index("--resume") + 1] == "sess-1"
    assert chat.session_key == "chat-claude" and "Claude" in chat.missing


def test_claude_not_finishing_is_an_error_naming_claude(tmp_path):
    from src.infrastructure.agents.claude import ClaudeChat
    assert list(ClaudeChat(claude_fake(tmp_path, "print('nothing')"), tmp_path).run("q")) == [{"type": "error", "message": "Claude stopped before answering."}]

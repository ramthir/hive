import json

from src.domain.chat import command_label, parse_line


def line(kind, **item):
    return json.dumps({"type": kind, "item": item})


def test_a_command_becomes_a_step_that_runs_then_is_done():
    started = parse_line(line("item.started", id="i1", type="command_execution", command="/bin/bash -lc 'rg -n wifi *.md'", status="in_progress"))
    assert started == {"type": "step", "id": "i1", "tool": "shell", "label": "rg -n wifi *.md", "write": False, "status": "running"}
    done = parse_line(line("item.completed", id="i1", type="command_execution", command="cat home.md", status="completed", exit_code=0))
    assert done["status"] == "done" and done["write"] is False


def test_a_failed_command_is_a_failed_step():
    assert parse_line(line("item.completed", id="1", type="command_execution", command="cat x", status="failed"))["status"] == "failed"
    assert parse_line(line("item.completed", id="1", type="command_execution", command="cat x", status="completed", exit_code=1))["status"] == "failed"


def test_commands_that_change_files_or_history_are_writes():
    def write(command):
        return parse_line(line("item.completed", id="1", type="command_execution", command=command, status="completed", exit_code=0))["write"]
    for command in ("sed -i 's/a/b/' x.md", "git add -- x.md && git commit -m 'doc: x' -- x.md", "echo hi >> x.md", "mv a.md b.md", "git mv a.md b.md", "rm a.md", "cat <<EOF > x.md"):
        assert write(command) is True, command
    for command in ("cat x.md", "git log --oneline -5", "git status --short", "sed -n 1,20p x.md", "ls -la"):
        assert write(command) is False, command


def test_a_file_change_is_an_edit_step():
    step = parse_line(line("item.completed", id="1", type="file_change", changes=[{"path": "a.md", "kind": "update"}], status="completed"))
    assert step["write"] is True and step["label"] == "Editing a.md" and step["status"] == "done"


def test_long_commands_are_cut_to_one_line():
    label = command_label("bash -lc 'rg -n " + "x" * 200 + "\n  more'")
    assert len(label) <= 90 and label.endswith("…") and "\n" not in label


def test_messages_done_and_errors():
    assert parse_line(line("item.completed", type="agent_message", text="  Hi  ")) == {"type": "message", "text": "Hi"}
    assert parse_line(line("item.completed", type="agent_message", text="  ")) is None
    assert parse_line(json.dumps({"type": "turn.completed", "usage": {"output_tokens": 3}})) == {"type": "done", "usage": {"output_tokens": 3}}
    assert parse_line(json.dumps({"type": "turn.failed", "error": {"message": "no auth"}})) == {"type": "error", "message": "no auth"}
    assert parse_line(json.dumps({"type": "error", "message": "boom"})) == {"type": "error", "message": "boom"}


def test_log_lines_and_other_events_are_ignored():
    for text in ("2026-11-21T12:29:42Z ERROR codex_core: x", "", "[1,2]", json.dumps({"type": "turn.started"}),
                 line("item.completed", type="mcp_tool_call", tool="read_note")):
        assert parse_line(text) is None


def test_the_thread_start_is_the_session_to_resume():
    assert parse_line(json.dumps({"type": "thread.started", "thread_id": "abc"})) == {"type": "session", "id": "abc"}
    assert parse_line(json.dumps({"type": "thread.started"})) is None

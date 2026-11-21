import json

from src.domain.chat import parse_line, tool_label


def line(kind, **item):
    return json.dumps({"type": kind, "item": item})


def test_a_tool_call_becomes_a_step_that_runs_then_is_done():
    started = parse_line(line("item.started", id="i1", type="mcp_tool_call", tool="read_note", arguments={"slug": "home-network"}, status="in_progress"))
    assert started == {"type": "step", "id": "i1", "tool": "read_note", "label": "Reading home-network", "write": False, "status": "running"}
    done = parse_line(line("item.completed", id="i1", type="mcp_tool_call", tool="edit_note", arguments={"slug": "a"}, status="completed", result={"content": []}))
    assert done["status"] == "done" and done["write"] is True


def test_a_failed_or_error_result_is_a_failed_step():
    assert parse_line(line("item.completed", id="1", type="mcp_tool_call", tool="read_note", status="failed"))["status"] == "failed"
    assert parse_line(line("item.completed", id="1", type="mcp_tool_call", tool="read_note", status="completed", result={"is_error": True}))["status"] == "failed"
    assert parse_line(line("item.completed", id="1", type="mcp_tool_call", tool="read_note", status="completed", error={"message": "x"}))["status"] == "failed"


def test_messages_done_and_errors():
    assert parse_line(line("item.completed", type="agent_message", text="  Hi  ")) == {"type": "message", "text": "Hi"}
    assert parse_line(line("item.completed", type="agent_message", text="  ")) is None
    assert parse_line(json.dumps({"type": "turn.completed", "usage": {"output_tokens": 3}})) == {"type": "done", "usage": {"output_tokens": 3}}
    assert parse_line(json.dumps({"type": "turn.failed", "error": {"message": "no auth"}})) == {"type": "error", "message": "no auth"}
    assert parse_line(json.dumps({"type": "error", "message": "boom"})) == {"type": "error", "message": "boom"}


def test_log_lines_and_other_events_are_ignored():
    for text in ("2026-11-21T12:29:42Z ERROR codex_core: x", "", "[1,2]", json.dumps({"type": "turn.started"}),
                 line("item.completed", type="command_execution", command="ls")):
        assert parse_line(text) is None


def test_labels():
    assert tool_label("search_notes", {"query": "wifi"}) == "Searching notes: wifi"
    assert tool_label("create_note", {"title": "Plan"}) == "Creating Plan"
    assert tool_label("list_notes", None) == "Listing notes"
    assert tool_label("something_new", {}) == "Something new"

import io
import json
import subprocess
import sys
from pathlib import Path

from src.application.chat.tools import NotesTools
from src.application.notes.service import NoteService
from src.infrastructure.chat.notes_mcp import handle, serve
from src.infrastructure.fs_notes.repository import FileNoteRepository

ROOT = Path(__file__).resolve().parents[2]


def make(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    service = NoteService(FileNoteRepository(tmp_path))
    service.create("Alpha", "first")
    return NotesTools(service)


def test_initialize_lists_tools_and_answers_calls(tmp_path):
    tools = make(tmp_path)
    init = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}, tools)
    assert init["result"]["protocolVersion"] == "2025-03-26" and "tools" in init["result"]["capabilities"]
    assert handle({"jsonrpc": "2.0", "method": "notifications/initialized"}, tools) is None
    names = {t["name"] for t in handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, tools)["result"]["tools"]}
    assert {"search_notes", "edit_note"} <= names
    call = handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_note", "arguments": {"slug": "alpha"}}}, tools)
    assert "first" in call["result"]["content"][0]["text"] and "isError" not in call["result"]


def test_a_failed_call_is_an_error_result_not_a_dead_server(tmp_path):
    tools = make(tmp_path)
    call = handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_note", "arguments": {"slug": "nope"}}}, tools)
    assert call["result"]["isError"] is True
    assert handle({"jsonrpc": "2.0", "id": 4, "method": "nope"}, tools)["error"]["code"] == -32601


def test_serve_reads_lines_and_survives_garbage(tmp_path):
    out = io.StringIO()
    serve(make(tmp_path), io.StringIO('not json\n\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n'), out)
    replies = [json.loads(l) for l in out.getvalue().splitlines()]
    assert replies[0]["error"]["code"] == -32700 and replies[1] == {"jsonrpc": "2.0", "id": 1, "result": {}}


def test_the_server_runs_as_a_process_the_way_codex_starts_it(tmp_path):
    make(tmp_path)
    request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_notes", "arguments": {"query": "alpha"}}})
    proc = subprocess.run([sys.executable, "-m", "src.infrastructure.chat.notes_mcp"], input=request + "\n", capture_output=True, text=True,
                          cwd=ROOT, env={"NOTES_DIR": str(tmp_path), "PATH": "/usr/bin:/bin", "HOME": str(tmp_path)}, timeout=60)
    assert "slug: alpha" in json.loads(proc.stdout.splitlines()[0])["result"]["content"][0]["text"], proc.stderr

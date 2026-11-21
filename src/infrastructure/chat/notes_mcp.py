"""A minimal MCP server over stdio (newline-delimited JSON-RPC) that gives a Codex run the notes tools and nothing else.
Codex starts it: `python -m src.infrastructure.chat.notes_mcp` with NOTES_DIR in its environment. It writes through
NoteService, so a chat edit is a normal save (one git commit); the app's watcher or the end of the chat run refreshes
the index."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from src.application.chat.tools import TOOLS, NotesTools, ToolError
from src.application.notes.service import NoteService
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.git.client import GitClient

PROTOCOL = "2025-06-18"


def handle(message: dict, tools: NotesTools) -> dict | None:
    """The reply to one JSON-RPC message, or None for a notification."""
    method, ident = message.get("method"), message.get("id")
    if ident is None:
        return None
    if method == "initialize":
        version = (message.get("params") or {}).get("protocolVersion") or PROTOCOL
        result = {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "hive-notes", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = message.get("params") or {}
        try:
            result = {"content": [{"type": "text", "text": tools.call(params.get("name", ""), params.get("arguments"))}]}
        except ToolError as error:
            result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        except Exception as error:  # a failed save must reach the model, not kill the server
            result = {"content": [{"type": "text", "text": f"{type(error).__name__}: {error}"}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": ident, "result": result}


def serve(tools: NotesTools, stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        if not line.strip():
            continue
        try:
            reply = handle(json.loads(line), tools)
        except json.JSONDecodeError:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if reply is not None:
            stdout.write(json.dumps(reply) + "\n")
            stdout.flush()


def main() -> None:
    root = Path(os.environ["NOTES_DIR"]).expanduser().resolve()
    serve(NotesTools(NoteService(FileNoteRepository(root, GitClient(root)))))


if __name__ == "__main__":
    main()

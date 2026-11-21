"""Chat events: what `codex exec --json` prints, reduced to the few things the page shows."""
from __future__ import annotations

import json

# The notes tools that change a note; everything else only reads.
WRITE_TOOLS = frozenset({"create_note", "edit_note", "append_to_note", "rewrite_note", "set_note_properties", "log_time", "remove_time"})
TOOL_LABELS = {
    "search_notes": "Searching notes", "read_note": "Reading", "list_notes": "Listing notes", "backlinks": "Finding links to",
    "create_note": "Creating", "edit_note": "Editing", "append_to_note": "Adding to", "rewrite_note": "Rewriting",
    "set_note_properties": "Updating properties of",
    "list_time": "Listing time", "log_time": "Logging time on", "remove_time": "Removing time from",
}


def tool_label(tool: str, arguments: dict | None) -> str:
    """"Reading home-network", "Searching notes: wifi"."""
    args = arguments if isinstance(arguments, dict) else {}
    label = TOOL_LABELS.get(tool, tool.replace("_", " ").capitalize())
    if tool == "search_notes":
        return f"{label}: {args['query']}" if args.get("query") else label
    target = args.get("slug") or args.get("title")
    return f"{label} {target}" if target else label


def parse_line(line: str) -> dict | None:
    """One line of `codex exec --json` as an event for the page, or None for what the page does not show.
    Events: step (id, tool, label, write, status running|done|failed), message (text), done (usage), error (message)."""
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        return None  # Codex's own log lines share the stream
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    if kind in ("item.started", "item.completed") and item.get("type") == "mcp_tool_call":
        tool = str(item.get("tool") or "")
        result = item.get("result") if isinstance(item.get("result"), dict) else {}
        failed = item.get("status") == "failed" or bool(item.get("error")) or bool(result.get("is_error") or result.get("isError"))
        status = "running" if kind == "item.started" else "failed" if failed else "done"
        return {"type": "step", "id": item.get("id"), "tool": tool, "label": tool_label(tool, item.get("arguments")),
                "write": tool in WRITE_TOOLS, "status": status}
    if kind == "item.completed" and item.get("type") == "agent_message" and str(item.get("text") or "").strip():
        return {"type": "message", "text": str(item["text"]).strip()}
    if kind == "turn.completed":
        return {"type": "done", "usage": event.get("usage") or {}}
    if kind in ("turn.failed", "error"):
        detail = event.get("error") if isinstance(event.get("error"), dict) else {}
        return {"type": "error", "message": str(detail.get("message") or event.get("message") or "Codex failed")}
    return None

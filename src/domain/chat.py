"""Chat events: what `codex exec --json` prints, reduced to the few things the page shows."""
from __future__ import annotations

import json
import re

# A shell command that changes files or history; everything else only reads.
WRITE_COMMAND = re.compile(r"(^|[\s;&|(])(git\s+(commit|mv|rm|add|restore|checkout|reset|merge|rebase|stash|apply|am)|sed\s+(-\w*i|--in-place)|perl\s+-\w*i|mv|cp|rm|tee|touch|mkdir|truncate|patch|ed|ex)\b|>>?\s*[^\s&|]")
SHELL_WRAPPER = re.compile(r"^(?:/\S*/)?(?:ba|z)?sh\s+-\w*c\s+(['\"])(.*)\1$", re.DOTALL)
MAX_LABEL = 90


def command_label(command: str) -> str:
    """The command as the page shows it: without the `bash -lc '...'` wrapper, on one line, cut."""
    command = str(command or "").strip()
    if match := SHELL_WRAPPER.match(command):
        command = match.group(2)
    command = " ".join(command.split())
    return command if len(command) <= MAX_LABEL else command[:MAX_LABEL - 1] + "…"


def parse_line(line: str) -> dict | None:
    """One line of `codex exec --json` as an event for the page, or None for what the page does not show.
    Events: session (id: Codex's thread, to resume), step (id, tool, label, write, status running|done|failed), message (text),
    done (usage), error (message)."""
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        return None  # Codex's own log lines share the stream
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    if kind == "thread.started" and event.get("thread_id"):
        return {"type": "session", "id": str(event["thread_id"])}
    if kind in ("item.started", "item.completed") and item.get("type") in ("command_execution", "file_change"):
        failed = item.get("status") == "failed" or (kind == "item.completed" and item.get("exit_code") not in (None, 0))
        status = "running" if kind == "item.started" else "failed" if failed else "done"
        if item["type"] == "file_change":
            paths = [str(c.get("path")) for c in item.get("changes") or [] if isinstance(c, dict) and c.get("path")]
            return {"type": "step", "id": item.get("id"), "tool": "file_change", "label": "Editing " + (", ".join(paths) or "files"), "write": True, "status": status}
        command = command_label(item.get("command"))
        return {"type": "step", "id": item.get("id"), "tool": "shell", "label": command or "Running a command",
                "write": bool(WRITE_COMMAND.search(str(item.get("command") or ""))), "status": status}
    if kind == "item.completed" and item.get("type") == "agent_message" and str(item.get("text") or "").strip():
        return {"type": "message", "text": str(item["text"]).strip()}
    if kind == "turn.completed":
        return {"type": "done", "usage": event.get("usage") or {}}
    if kind in ("turn.failed", "error"):
        detail = event.get("error") if isinstance(event.get("error"), dict) else {}
        return {"type": "error", "message": str(detail.get("message") or event.get("message") or "Codex failed")}
    return None

"""Chat events: what `codex exec --json` prints, reduced to the few things the page shows."""
from __future__ import annotations

import json
import re

# A shell command that changes files or history; everything else only reads.
WRITE_COMMAND = re.compile(r"(^|[\s;&|(])(git\s+(commit|mv|rm|add|restore|checkout|reset|merge|rebase|stash|apply|am)|sed\s+(-\w*i|--in-place)|perl\s+-\w*i|mv|cp|rm|tee|touch|mkdir|truncate|patch|ed|ex)\b|>>?\s*[^\s&|]")
SHELL_WRAPPER = re.compile(r"^(?:/\S*/)?(?:ba|z)?sh\s+-\w*c\s+(['\"])(.*)\1$", re.DOTALL)
MAX_LABEL = 240


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


# --- Antigravity (`agy --print --output-format stream-json`) --------------------------------------------------------------
AGY_WRITE_TOOLS = re.compile(r"write|replace|edit|delete|move|rename|create|apply", re.I)
AGY_PATH_KEYS = ("CommandLine", "AbsolutePath", "TargetFile", "FilePath", "Path", "SearchPath", "DirectoryPath", "Query", "Pattern", "Url")
AGY_FAILED_OUTPUT = re.compile(r"Command failed to run|Command exited with code (?!0\b)\d+")


class AgyEvents:
    """Turns the lines of one `agy` run into the page's events (see `parse_line`). It keeps state: the text of a reply arrives in
    pieces (`text_delta`), and only a finished reply is a `message`."""

    def __init__(self):
        self.text: dict[int, str] = {}

    def feed(self, line: str) -> list[dict]:
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            return []
        if not isinstance(event, dict):
            return []
        kind = event.get("event")
        if kind == "init" and event.get("conversation_id"):
            return [{"type": "session", "id": str(event["conversation_id"])}]
        if kind == "step_update" and isinstance(event.get("step_update"), dict):
            return self._step(event["step_update"])
        if kind == "result" and isinstance(event.get("result"), dict):
            result = event["result"]
            if result.get("status") == "SUCCESS":
                usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
                return [{"type": "done", "usage": {"input_tokens": usage.get("input_tokens", 0), "output_tokens": usage.get("output_tokens", 0)}}]
            return [{"type": "error", "message": str(result.get("error") or result.get("message") or f"Antigravity ended with {result.get('status') or 'an error'}")}]
        if kind == "error":
            return [{"type": "error", "message": str(event.get("message") or (event.get("error") or {}).get("message") or "Antigravity failed")}]
        return []

    def _step(self, step: dict) -> list[dict]:
        index = step.get("step_index")
        state = str(step.get("state") or "")
        if step.get("step_type") == "agent_response":
            self.text[index] = self.text.get(index, "") + str(step.get("text_delta") or "")
            text = self.text.get(index, "").strip()
            return [{"type": "message", "text": text}] if state == "DONE" and text else []
        if step.get("step_type") != "tool":
            return []
        info = step.get("tool_info") if isinstance(step.get("tool_info"), dict) else {}
        params = info.get("parameters") if isinstance(info.get("parameters"), dict) else {}
        tool = str(step.get("tool_name") or info.get("name") or "tool")
        if tool == "run_command":
            command = str(params.get("CommandLine") or "")
            label, write = command_label(command) or "Running a command", bool(WRITE_COMMAND.search(command))
        else:
            target = next((str(params[k]) for k in AGY_PATH_KEYS if params.get(k)), "")
            label, write = (f"{tool.replace('_', ' ').capitalize()} {target}".strip()), bool(AGY_WRITE_TOOLS.search(tool))
        failed = state not in ("ACTIVE", "DONE") or (state == "DONE" and bool(AGY_FAILED_OUTPUT.search(str(info.get("output") or ""))))
        status = "running" if state == "ACTIVE" else "failed" if failed else "done"
        return [{"type": "step", "id": f"{step.get('conversation_id', '')}:{index}", "tool": "shell" if tool == "run_command" else tool,
                 "label": label, "write": write, "status": status}]


CLAUDE_PATH_KEYS = ("file_path", "path", "notebook_path", "pattern", "url", "query")
CLAUDE_WRITE_TOOLS = re.compile(r"^(Edit|Write|MultiEdit|NotebookEdit)$")


class ClaudeEvents:
    """Turns the lines of one `claude -p --output-format stream-json --verbose` run into the page's events (see `parse_line`).
    Each line is a whole message: the first is `system`/`init` (the session id), an `assistant` one holds text and `tool_use`
    blocks, the `user` one after it holds the `tool_result`s, and `result` ends the run. It keeps what each tool call looked like
    so its result can finish the same step."""

    def __init__(self):
        self.steps: dict[str, dict] = {}

    def feed(self, line: str) -> list[dict]:
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            return []
        if not isinstance(event, dict):
            return []
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init" and event.get("session_id"):
            return [{"type": "session", "id": str(event["session_id"])}]
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        blocks = message.get("content") if isinstance(message.get("content"), list) else []
        if kind == "assistant" and not event.get("parent_tool_use_id"):
            return [out for block in blocks if isinstance(block, dict) for out in self._block(block)]
        if kind == "user":
            return [self._result(block) for block in blocks if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") in self.steps]
        if kind == "result":
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                return [{"type": "error", "message": str(event.get("result") or f"Claude ended with {event.get('subtype') or 'an error'}")}]
            usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
            return [{"type": "done", "usage": {"input_tokens": usage.get("input_tokens", 0), "output_tokens": usage.get("output_tokens", 0)}}]
        return []

    def _block(self, block: dict) -> list[dict]:
        if block.get("type") == "text":
            text = str(block.get("text") or "").strip()
            return [{"type": "message", "text": text}] if text else []
        if block.get("type") != "tool_use":
            return []
        tool = str(block.get("name") or "tool")
        params = block.get("input") if isinstance(block.get("input"), dict) else {}
        if tool == "Bash":
            command = str(params.get("command") or "")
            label, write = command_label(command) or "Running a command", bool(WRITE_COMMAND.search(command))
        else:
            target = next((str(params[k]) for k in CLAUDE_PATH_KEYS if params.get(k)), "")
            label, write = f"{tool} {target}".strip(), bool(CLAUDE_WRITE_TOOLS.match(tool))
        step = {"type": "step", "id": str(block.get("id") or label), "tool": "shell" if tool == "Bash" else tool, "label": label, "write": write, "status": "running"}
        self.steps[step["id"]] = step
        return [step]

    def _result(self, block: dict) -> dict:
        return {**self.steps[block["tool_use_id"]], "status": "failed" if block.get("is_error") else "done"}

"""Answers a chat by running Codex once (`codex exec --json`) with only the notes tools: its shell is turned off and it
runs in an empty scratch folder, so the notes are reachable through Hive's MCP server and nothing else. A chat is one Codex
session (so ccusage counts it): the first question starts it (`thread.started` gives its id), later ones `codex exec resume <id>`."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path

from src.domain.chat import parse_line

log = logging.getLogger("hive.chat")

ROOT = Path(__file__).resolve().parents[3]


def _toml(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_args(program: str, scratch: str, notes_dir: Path, python: str = sys.executable, model: str | None = None,
               effort: str | None = None, session: str | None = None) -> list[str]:
    # `exec resume` has no --sandbox or -C: the sandbox goes through -c and the working folder is the process's own
    head = ([program, "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"'] if session
            else [program, "exec", "--json", "--sandbox", "read-only", "-C", scratch])
    return [*head, "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--disable", "shell_tool", "--disable", "unified_exec",
            "-c", f"mcp_servers.hive.command={_toml(python)}",
            "-c", 'mcp_servers.hive.args=["-m","src.infrastructure.chat.notes_mcp"]',
            "-c", f"mcp_servers.hive.cwd={_toml(str(ROOT))}",
            "-c", f"mcp_servers.hive.env={{NOTES_DIR={_toml(str(notes_dir))}}}",
            "-c", 'mcp_servers.hive.default_tools_approval_mode="approve"',
            *(["--model", model] if model else []),
            *(["-c", f'model_reasoning_effort="{effort}"'] if effort else []), *([session] if session else []), "-"]


class CodexChat:
    def __init__(self, program: str, notes_dir: Path, model: str | None = None, effort: str | None = None, timeout: float = 600,
                 scratch: Path | None = None):
        self.program, self.notes_dir, self.model, self.effort, self.timeout = program, Path(notes_dir), model, effort, timeout
        self.scratch = Path(scratch) if scratch else None

    def _scratch(self) -> Path:
        """Codex's working folder: empty, never the notes, and the same for every run (a resumed session remembers where it worked)."""
        if self.scratch is None:
            self.scratch = Path(tempfile.mkdtemp(prefix="hive-chat-"))
        self.scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        return self.scratch

    def run(self, prompt: str, session: str | None = None) -> Iterator[dict]:
        """Events (see `domain.chat.parse_line`) until Codex finishes. Closing the generator (the client left) stops Codex.
        Ends with an error event when Codex exits without finishing its turn."""
        env = {"PATH": f"{os.path.dirname(self.program)}:{os.path.dirname(sys.executable)}:/usr/local/bin:/usr/bin:/bin",
               "HOME": os.path.expanduser("~"), "LANG": "C.UTF-8"}
        env.update({name: os.environ[name] for name in ("CODEX_HOME", "OPENAI_API_KEY") if name in os.environ})
        proc = None
        timer = None
        finished = False
        try:
            scratch = str(self._scratch())
            proc = subprocess.Popen(build_args(self.program, scratch, self.notes_dir, model=self.model, effort=self.effort, session=session),
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=scratch)
            timer = threading.Timer(self.timeout, proc.kill)
            timer.start()
            proc.stdin.write(prompt.encode())
            proc.stdin.close()
            for raw in proc.stdout:
                event = parse_line(raw.decode("utf-8", "replace"))
                if event:
                    finished = finished or event["type"] in ("done", "error")
                    yield event
            proc.wait()
            if not finished:
                yield {"type": "error", "message": "Codex took too long and was stopped." if proc.returncode < 0 else "Codex stopped before answering."}
        except OSError as error:
            log.warning("codex could not run: %s", error)
            yield {"type": "error", "message": f"Codex could not run: {error}"}
        finally:
            if timer:
                timer.cancel()
            if proc and proc.poll() is None:
                proc.kill()
                proc.wait()

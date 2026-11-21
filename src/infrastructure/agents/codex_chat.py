"""Answers a chat by running Codex once (`codex exec --json`) with only the notes tools: its shell is turned off and it
runs in an empty scratch folder, so the notes are reachable through Hive's MCP server and nothing else. Nothing is saved
by Codex (`--ephemeral`); the page sends the recent turns with every question."""
from __future__ import annotations

import logging
import os
import shutil
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
               effort: str | None = None) -> list[str]:
    return [program, "exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
            "--ignore-rules", "--disable", "shell_tool", "--disable", "unified_exec", "-C", scratch,
            "-c", f"mcp_servers.hive.command={_toml(python)}",
            "-c", 'mcp_servers.hive.args=["-m","src.infrastructure.chat.notes_mcp"]',
            "-c", f"mcp_servers.hive.cwd={_toml(str(ROOT))}",
            "-c", f"mcp_servers.hive.env={{NOTES_DIR={_toml(str(notes_dir))}}}",
            "-c", 'mcp_servers.hive.default_tools_approval_mode="approve"',
            *(["--model", model] if model else []),
            *(["-c", f'model_reasoning_effort="{effort}"'] if effort else []), "-"]


class CodexChat:
    def __init__(self, program: str, notes_dir: Path, model: str | None = None, effort: str | None = None, timeout: float = 600):
        self.program, self.notes_dir, self.model, self.effort, self.timeout = program, Path(notes_dir), model, effort, timeout

    def run(self, prompt: str) -> Iterator[dict]:
        """Events (see `domain.chat.parse_line`) until Codex finishes. Closing the generator (the client left) stops Codex.
        Ends with an error event when Codex exits without finishing its turn."""
        env = {"PATH": f"{os.path.dirname(self.program)}:{os.path.dirname(sys.executable)}:/usr/local/bin:/usr/bin:/bin",
               "HOME": os.path.expanduser("~"), "LANG": "C.UTF-8"}
        env.update({name: os.environ[name] for name in ("CODEX_HOME", "OPENAI_API_KEY") if name in os.environ})
        scratch = tempfile.mkdtemp(prefix="hive-chat-")  # Codex's working folder: empty, never the notes
        proc = None
        timer = None
        finished = False
        try:
            proc = subprocess.Popen(build_args(self.program, scratch, self.notes_dir, model=self.model, effort=self.effort),
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
            shutil.rmtree(scratch, ignore_errors=True)

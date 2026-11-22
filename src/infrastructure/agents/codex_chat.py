"""Answers a chat by running Codex (`codex exec --json`) in the notes folder with its own shell (rg, sed, git...), the way
you would use it in a terminal: it reads and edits the notes directly and commits them itself. A chat is one Codex session
(so ccusage counts it): the first question starts it (`thread.started` gives its id), later ones `codex exec resume <id>`.

Codex runs WITHOUT a sandbox (`--dangerously-bypass-approvals-and-sandbox`) because bubblewrap cannot start where there are no
user namespaces, so the port must only be reachable from this machine (publish it as `-p 127.0.0.1:80:80`)."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

from src.domain.chat import parse_line

log = logging.getLogger("hive.chat")


def build_args(program: str, notes_dir: Path | str, model: str | None = None, effort: str | None = None, session: str | None = None) -> list[str]:
    # `exec resume` has no -C: the working folder is the process's own (the notes folder), which a resumed session remembers
    head = [program, "exec", "resume", "--json"] if session else [program, "exec", "--json", "-C", str(notes_dir)]
    return [*head, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
            *(["--model", model] if model else []), *(["-c", f'model_reasoning_effort="{effort}"'] if effort else []),
            *([session] if session else []), "-"]


class CodexChat:
    def __init__(self, program: str, notes_dir: Path, model: str | None = None, effort: str | None = None, timeout: float = 600):
        self.program, self.notes_dir, self.model, self.effort, self.timeout = program, Path(notes_dir), model, effort, timeout

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
            proc = subprocess.Popen(build_args(self.program, self.notes_dir, model=self.model, effort=self.effort, session=session),
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=self.notes_dir)
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

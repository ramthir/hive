"""Gives a fresh commit a better message in the background, so a save never waits for the model.

The commit is made at once with the plain message ("doc: update Title"); this then replaces it with the one the writer
derives from the diff. It only ever touches the newest, unpushed, single-parent commit, and only its message: the tree,
author and dates stay, and the index and working tree are not involved. If another commit has landed meanwhile, or the
commit was pushed, the plain message stays."""
from __future__ import annotations

import logging
import queue
import threading
from typing import Protocol

from src.infrastructure.git.client import GitClient
from src.infrastructure.metrics import Metrics

log = logging.getLogger("hive.commit_messages")


class MessageWriter(Protocol):
    def describe(self, title: str, subject: str, diff: str) -> str | None: ...


class CommitRewriter:
    def __init__(self, git: GitClient, writer: MessageWriter, metrics: Metrics | None = None):
        self.git, self.writer, self.metrics = git, writer, metrics or Metrics()
        self._jobs: queue.Queue[tuple[str, str, list[str]] | None] = queue.Queue()
        self._thread = threading.Thread(target=self._work, name="commit-messages", daemon=True)
        self._thread.start()

    def submit(self, sha: str, title: str, paths: list[str]) -> None:
        self._jobs.put((sha, title, paths))

    def wait(self, timeout: float = 30) -> None:
        """Block until the queued jobs are done (tests)."""
        done = threading.Event()
        self._jobs.put((done, "", []))  # type: ignore[arg-type]
        done.wait(timeout)

    def stop(self) -> None:
        self._jobs.put(None)

    def _work(self) -> None:
        while (job := self._jobs.get()) is not None:
            sha, title, paths = job
            if isinstance(sha, threading.Event):
                sha.set()
                continue
            try:
                self._reword(sha, title, paths)
            except Exception:  # a failed rewording must never take the worker down
                log.exception("rewording %s failed", sha[:7])
                self.metrics.incr("commit_message_errors")

    def _reword(self, sha: str, title: str, paths: list[str]) -> None:
        subject = self.git.subject(sha)
        with self.metrics.time("commit_message"):
            message = self.writer.describe(title, subject, self.git.diff_of(sha, paths))
        if not message or message == subject:
            self.metrics.incr("commit_message_kept")
            return
        if self.git.reword(sha, message):
            self.metrics.incr("commit_message_reworded")
        else:
            self.metrics.incr("commit_message_kept")

"""Notice markdown files changed outside the app (editor, `git pull`) and mark the index stale.

Uses watchfiles (inotify via the Rust `notify` crate): the thread sleeps in the kernel until the
filesystem reports a change, so an idle watcher costs no CPU. Changes are debounced into batches,
and a batch only *invalidates* the index; the rebuild happens lazily on the next request.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from watchfiles import watch

from src.infrastructure.metrics import Metrics


def _is_note(change, path: str) -> bool:
    return path.endswith(".md") and "/.git/" not in path


class NotesWatcher:
    def __init__(self, root: Path, on_change: Callable[[list[str]], None], metrics: Metrics, debounce_ms: int = 400,
                 step_ms: int = 250):
        self.root, self.on_change, self.metrics = Path(root), on_change, metrics
        # `step` is how often watchfiles wakes to check the stop flag/debounce; larger = fewer idle wakeups.
        self.debounce_ms, self.step_ms = debounce_ms, step_ms
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="notes-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        for batch in watch(self.root, watch_filter=_is_note, debounce=self.debounce_ms, step=self.step_ms, stop_event=self._stop,
                           raise_interrupt=False, recursive=False):
            paths = sorted({Path(p).stem for _, p in batch})
            self.metrics.incr("watcher_batches")
            self.metrics.incr("watcher_events", len(batch))
            self.on_change(paths)

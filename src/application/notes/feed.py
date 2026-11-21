"""Tell open pages that notes changed, whether Hive saved them or something else did (editor, `git pull`).

`NoteService.invalidate` is the one place both kinds of change pass through, so it publishes here. A subscriber
asks for one note (`note=slug`: the note page) or one type (`type=task`: the task board) and gets only those; a
change too big to list, or "everything may have changed", reaches everyone as a `reset`. Events carry the
file's `revision`, so a page can tell its own save from someone else's. Publishing may happen on any thread.
"""
from __future__ import annotations

import asyncio
import threading

QUEUE_SIZE = 100


class Subscription:
    def __init__(self, feed: "ChangeFeed", note: str | None, type_: str | None):
        self.feed, self.note = feed, note
        self.type = type_.casefold() if type_ else None
        self.queue: asyncio.Queue = asyncio.Queue(QUEUE_SIZE)
        self._loop = asyncio.get_running_loop()

    def wants(self, event: dict) -> bool:
        if event.get("reset"):
            return True
        if self.note is not None:
            return event["slug"] == self.note
        if self.type is not None:
            return self.type in event["types"]
        return True

    def deliver(self, event: dict) -> None:
        try:
            self._loop.call_soon_threadsafe(self._put, event)
        except RuntimeError:  # the loop is closed: the app is shutting down
            pass

    def _put(self, event: dict) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:  # a viewer that cannot keep up: drop what it missed and tell it to look again
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait({"reset": True})

    def close(self) -> None:
        self.feed._remove(self)


class ChangeFeed:
    def __init__(self):
        self._subs: set[Subscription] = set()
        self._lock = threading.Lock()
        self._seen: dict[str, str | None] = {}  # slug -> the revision last announced (None: removed)

    @property
    def active(self) -> bool:
        return bool(self._subs)

    def subscribe(self, note: str | None = None, type: str | None = None) -> Subscription:
        """Call from the event loop."""
        sub = Subscription(self, note, type)
        with self._lock:
            self._subs.add(sub)
        return sub

    def _remove(self, sub: Subscription) -> None:
        with self._lock:
            self._subs.discard(sub)
            if not self._subs:
                self._seen.clear()

    def publish(self, events: list[dict]) -> None:
        """Send each event to the subscribers that want it. An event that repeats the last one announced for its note
        (a save and then the watcher seeing the same file) is dropped."""
        with self._lock:
            subs = list(self._subs)
            fresh = []
            for event in events:
                if self._seen.get(event["slug"], "") == event["revision"]:
                    continue
                self._seen[event["slug"]] = event["revision"]
                fresh.append(event)
        for event in fresh:
            for sub in subs:
                if sub.wants(event):
                    sub.deliver(event)

    def reset(self) -> None:
        with self._lock:
            subs = list(self._subs)
            self._seen.clear()
        for sub in subs:
            sub.deliver({"reset": True})

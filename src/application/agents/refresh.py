"""A report kept in a file and refreshed on demand, without a scheduler.

A request reads the file. When it is older than `interval` the answer is still the old report and a background thread
makes a new one, so a request never waits for the program that makes it. Subclasses decide what a usable report is
(`usable`) and whether the very first request waits for one (`wait_for_first`). A failed run keeps the old report and
is not retried for `RETRY_AFTER`, so a missing program costs one attempt a minute, not one per poll.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

log = logging.getLogger("hive.agents")
REFRESH_EVERY = timedelta(minutes=15)
RETRY_AFTER = timedelta(minutes=1)


class RefreshingReport:
    wait_for_first = True  # False: a request with no report starts one and answers "not yet" instead of waiting
    metric = "agents"  # counters `<metric>_refreshes`, `<metric>_refresh_errors`, timing `<metric>_collect`

    def __init__(self, store, collector, parse, errors, metrics=None, interval: timedelta = REFRESH_EVERY, clock=None, background: bool = True):
        self.store = store
        self.collector = collector
        self.parse = parse  # validates what the collector made; raises one of `errors` when it is unusable
        self.errors = (*errors, OSError)
        self.metrics = metrics
        self.interval = interval
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.background = background
        self.error: str | None = None  # why the last refresh failed; cleared by the next one that works
        self._failed_at: datetime | None = None
        self._refresh_lock = threading.Lock()  # one run at a time
        self._thread: threading.Thread | None = None

    def usable(self, envelope, now: datetime) -> bool:
        return True

    def refresh(self) -> bool:
        """Make a new report now. False (and `error` set) when that failed; the last good report is kept."""
        with self._refresh_lock:
            return self._collect()

    def _collect(self) -> bool:
        """One run; the caller holds `_refresh_lock`."""
        now = self.clock()
        try:
            if self.metrics:
                with self.metrics.time(f"{self.metric}_collect"):
                    raw = self.collector.collect(now)
            else:
                raw = self.collector.collect(now)
            self.parse(raw)
            self.store.save(raw)
        except self.errors as exc:
            self.error, self._failed_at = str(exc), now
            log.warning("%s refresh failed: %s", self.metric, exc)
            if self.metrics:
                self.metrics.incr(f"{self.metric}_refresh_errors")
            return False
        self.error = self._failed_at = None
        if self.metrics:
            self.metrics.incr(f"{self.metric}_refreshes")
        return True

    def _current(self):
        envelope, error = self.store.load()
        now = self.clock()
        if envelope is not None and self.usable(envelope, now):
            if now - envelope["generated_at"] > self.interval:
                self._refresh_later(now)
            return envelope, error
        if not self.wait_for_first:
            self._refresh_later(now)
            return self.store.load() if not self.background else (envelope, error)
        # Nothing usable: wait for a report. Requests that arrive meanwhile queue on the lock and then find it.
        with self._refresh_lock:
            envelope, error = self.store.load()
            if envelope is not None and self.usable(envelope, self.clock()):
                return envelope, error
            if not self._recently_failed(self.clock()) and self._collect():
                return self.store.load()
        return envelope, error

    def _recently_failed(self, now: datetime) -> bool:
        return self._failed_at is not None and now - self._failed_at < RETRY_AFTER

    def _refresh_later(self, now: datetime) -> None:
        if self._recently_failed(now) or self._refresh_lock.locked():
            return
        if not self.background:
            self.refresh()
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self.refresh, name=f"{self.metric}-refresh", daemon=True)
        self._thread.start()

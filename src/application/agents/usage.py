"""Agent usage for the current month, kept fresh without a scheduler.

The report is a file (`ReportStore`). A request reads it; when it is older than `interval` the answer is still the
old report and a background thread makes a new one, so the page never waits for ccusage. Only when there is no report
for this month at all (first run, a new month) does the request wait for one. A failed run is not retried for
`RETRY_AFTER`, so a missing ccusage costs one attempt a minute, not one per poll.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from src.domain.agents.usage import CollectError, ReportError, build_view, empty_session_page, parse_envelope, session_page, unavailable_view

log = logging.getLogger("hive.agents")
REFRESH_EVERY = timedelta(minutes=15)
RETRY_AFTER = timedelta(minutes=1)


class AgentUsage:
    def __init__(self, store, collector, metrics=None, interval: timedelta = REFRESH_EVERY, clock=None, background: bool = True):
        self.store = store
        self.collector = collector
        self.metrics = metrics
        self.interval = interval
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.background = background
        self.error: str | None = None  # why the last refresh failed; cleared by the next one that works
        self._failed_at: datetime | None = None
        self._refresh_lock = threading.Lock()  # one ccusage run at a time
        self._thread: threading.Thread | None = None

    def view(self) -> dict:
        envelope, error = self._current()
        if envelope is None:
            return unavailable_view(self.error or error)
        view = build_view(envelope, self.clock())
        if view["status"] == "stale" and self.error:
            view["reason"] = f"{view['reason']} The last refresh failed: {self.error}"
        return view

    def sessions(self, sort="last_activity", direction="desc", page=0, page_size=10) -> dict:
        envelope, _ = self._current()
        if envelope is None:
            return empty_session_page(sort, direction, page, page_size)
        return session_page(envelope, self.clock(), sort, direction, page, page_size)

    def refresh(self) -> bool:
        """Make a new report now. False (and `error` set) when that failed; the last good report is kept."""
        with self._refresh_lock:
            return self._collect()

    def _collect(self) -> bool:
        """One ccusage run; the caller holds `_refresh_lock`."""
        now = self.clock()
        try:
            if self.metrics:
                with self.metrics.time("agents_collect"):
                    raw = self.collector.collect(now)
            else:
                raw = self.collector.collect(now)
            parse_envelope(raw)
            self.store.save(raw)
        except (CollectError, ReportError, OSError) as exc:
            self.error, self._failed_at = str(exc), now
            log.warning("agent usage refresh failed: %s", exc)
            if self.metrics:
                self.metrics.incr("agents_refresh_errors")
            return False
        self.error = self._failed_at = None
        if self.metrics:
            self.metrics.incr("agents_refreshes")
        return True

    def _usable(self, envelope, now: datetime) -> bool:
        """A report that starts on the 1st of the current month (in its own timezone)."""
        local = now.astimezone(envelope["zone"])
        since = envelope["since"]
        return (since.year, since.month, since.day) == (local.year, local.month, 1)

    def _current(self):
        envelope, error = self.store.load()
        now = self.clock()
        if envelope is not None and self._usable(envelope, now):
            if now - envelope["generated_at"] > self.interval:
                self._refresh_later(now)
            return envelope, error
        # Nothing for this month: wait for a report. Requests that arrive meanwhile queue on the lock and then find it.
        with self._refresh_lock:
            envelope, error = self.store.load()
            if envelope is not None and self._usable(envelope, self.clock()):
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
        self._thread = threading.Thread(target=self.refresh, name="agent-usage-refresh", daemon=True)
        self._thread.start()

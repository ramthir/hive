"""Agent usage for the current month, refreshed on the quarter hour (see `RefreshingReport`).

Only a missing report or a new month makes a request wait for ccusage (it takes a fraction of a second); a due report
is served while a new one is made in the background.
"""
from __future__ import annotations

from datetime import datetime

from src.application.agents.refresh import REFRESH_EVERY, RefreshingReport
from src.domain.agents.usage import CollectError, ReportError, build_view, empty_session_page, parse_envelope, session_page, unavailable_view

__all__ = ["AgentUsage", "REFRESH_EVERY"]


class AgentUsage(RefreshingReport):
    def __init__(self, store, collector, metrics=None, interval=REFRESH_EVERY, clock=None, background: bool = True):
        super().__init__(store, collector, parse_envelope, (CollectError, ReportError), metrics, interval, clock, background)

    def usable(self, envelope, now: datetime) -> bool:
        """A report that starts on the 1st of the current month (in its own timezone)."""
        local = now.astimezone(envelope["zone"])
        since = envelope["since"]
        return (since.year, since.month, since.day) == (local.year, local.month, 1)

    def view(self) -> dict:
        envelope, error = self._current()
        if envelope is None:
            return unavailable_view(self.error or error)
        view = build_view(envelope, self.clock())
        if view["status"] == "stale" and self.error:
            view["reason"] = f"{view['reason']} The last refresh failed: {self.error}"
        return view

    def sessions(self, sort="last_activity", direction="desc", page=0, page_size=10, provider: str | None = None) -> dict:
        envelope, _ = self._current()
        if envelope is None:
            return empty_session_page(sort, direction, page, page_size, provider)
        return session_page(envelope, self.clock(), sort, direction, page, page_size, provider)

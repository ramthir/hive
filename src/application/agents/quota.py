"""The 5-hour and weekly quota of the coding agents, refreshed on the quarter hour (see `RefreshingReport`).

Unlike the usage report, the first request does not wait: reading the three CLIs takes a few seconds (Antigravity up to a
minute), so it starts the run and answers "being collected"; the page asks again shortly.
"""
from __future__ import annotations

from src.application.agents.refresh import REFRESH_EVERY, RefreshingReport
from src.domain.agents.quota import QuotaCollectError, QuotaError, build_view, parse_snapshot, unavailable_view

PENDING = "The quota is being collected."


class AgentQuota(RefreshingReport):
    wait_for_first = False
    metric = "agents_quota"

    def __init__(self, store, collector, metrics=None, interval=REFRESH_EVERY, clock=None, background: bool = True):
        super().__init__(store, collector, parse_snapshot, (QuotaCollectError, QuotaError), metrics, interval, clock, background)

    def view(self) -> dict:
        snapshot, _ = self._current()
        if snapshot is None:
            return unavailable_view(self.error or PENDING)
        return build_view(snapshot, self.clock())

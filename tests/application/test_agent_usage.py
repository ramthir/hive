import threading
from datetime import datetime, timedelta, timezone

from src.application.agents.usage import AgentUsage
from src.domain.agents.usage import CollectError
from src.infrastructure.agents.usage_files import ReportStore
from src.infrastructure.metrics import Metrics
from tests.agent_reports import envelope, report

START = datetime(2026, 11, 21, 8, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class Collector:
    """Makes a report as of `now`; `fail` turns it into a ccusage that cannot run."""

    def __init__(self):
        self.calls = 0
        self.fail = None
        self.gate = None

    def collect(self, now):
        self.calls += 1
        if self.gate:
            self.gate.wait(5)
        if self.fail:
            raise CollectError(self.fail)
        since = now.replace(day=1).strftime("%Y-%m-%d")
        return envelope(now, since=since)


def make(tmp_path, background=False):
    clock, collector, metrics = Clock(), Collector(), Metrics()
    usage = AgentUsage(ReportStore(tmp_path / "usage.json"), collector, metrics, clock=clock, background=background)
    return usage, collector, clock, metrics


def test_the_first_request_waits_for_a_report_and_gets_it(tmp_path):
    usage, collector, _, metrics = make(tmp_path)
    view = usage.view()
    assert view["status"] == "ok" and view["providers"]["claude"]["tokens"]["total"] > 0
    assert collector.calls == 1 and (tmp_path / "usage.json").exists()
    assert metrics.snapshot()["counters"]["agents_refreshes"] == 1 and "agents_collect" in metrics.snapshot()["timings"]


def test_a_fresh_report_is_not_collected_again(tmp_path):
    usage, collector, clock, _ = make(tmp_path)
    usage.view()
    clock.advance(minutes=14)
    usage.view(); usage.sessions()
    assert collector.calls == 1


def test_an_old_report_is_still_served_while_a_new_one_is_made_in_the_background(tmp_path):
    usage, collector, clock, _ = make(tmp_path, background=True)
    usage.view()
    clock.advance(minutes=16)
    collector.gate = threading.Event()  # the refresh is slow: the request must not wait for it
    served = usage.view()
    assert served["status"] == "ok" and collector.calls == 2
    usage.view()  # another poll while it runs does not start a second one
    assert collector.calls == 2
    collector.gate.set()
    usage._thread.join(5)
    assert usage.store.load()[0]["generated_at"] == clock.now


def test_a_failed_refresh_keeps_the_old_report_and_says_so_once_it_is_stale(tmp_path):
    usage, collector, clock, metrics = make(tmp_path)
    usage.view()
    collector.fail = "ccusage exited 1: boom"
    clock.advance(minutes=20)
    assert usage.view()["status"] == "ok"  # old, but not yet considered stale
    clock.advance(minutes=30)
    stale = usage.view()
    assert stale["status"] == "stale" and "boom" in stale["reason"] and stale["providers"]["claude"]["tokens"]
    assert metrics.snapshot()["counters"]["agents_refresh_errors"] == 2  # at +20 min and again at +50


def test_a_failure_is_not_retried_on_every_poll(tmp_path):
    usage, collector, clock, _ = make(tmp_path)
    collector.fail = "ccusage was not found"
    for _ in range(3):
        view = usage.view()
        assert view["status"] == "unavailable" and "not found" in view["reason"]
    assert collector.calls == 1
    clock.advance(minutes=2)
    collector.fail = None
    assert usage.view()["status"] == "ok" and collector.calls == 2 and usage.error is None


def test_sessions_with_no_report_are_an_empty_page_not_an_error(tmp_path):
    usage, collector, _, _ = make(tmp_path)
    collector.fail = "nope"
    assert usage.sessions(page_size=5) == {"items": [], "total": 0, "page": 0, "page_size": 5, "sort": "last_activity", "dir": "desc"}


def test_a_new_month_makes_its_report_at_once_instead_of_showing_last_months(tmp_path):
    usage, collector, clock, _ = make(tmp_path)
    usage.view()
    clock.now = datetime(2026, 12, 1, 0, 30, tzinfo=timezone.utc)
    view = usage.view()
    assert view["month"] == "2026-12" and view["status"] == "ok" and collector.calls == 2


def test_requests_that_arrive_together_share_the_first_report(tmp_path):
    usage, collector, _, _ = make(tmp_path)
    collector.gate = threading.Event()
    results = []
    threads = [threading.Thread(target=lambda: results.append(usage.view()["status"])) for _ in range(4)]
    for t in threads:
        t.start()
    collector.gate.set()
    for t in threads:
        t.join(5)
    assert results == ["ok"] * 4 and collector.calls == 1


def test_a_report_that_does_not_validate_is_not_saved(tmp_path):
    usage, collector, _, _ = make(tmp_path)
    collector.collect = lambda now: {"schema_version": 1}
    assert usage.view()["status"] == "unavailable" and not (tmp_path / "usage.json").exists()

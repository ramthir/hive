import threading
from datetime import datetime, timedelta, timezone

from src.application.agents.quota import PENDING, AgentQuota
from src.domain.agents.quota import QuotaError, parse_snapshot
from src.infrastructure.agents.usage_files import ReportStore
from src.infrastructure.metrics import Metrics
from tests.agent_reports import quota_snapshot

START = datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now


class Collector:
    def __init__(self):
        self.calls = 0
        self.gate = None

    def collect(self, now):
        self.calls += 1
        if self.gate:
            self.gate.wait(5)
        return quota_snapshot(now)


def make(tmp_path, background=False):
    clock, collector, metrics = Clock(), Collector(), Metrics()
    store = ReportStore(tmp_path / "quota.json", parse_snapshot, (QuotaError,), "quota snapshot")
    return AgentQuota(store, collector, metrics, clock=clock, background=background), collector, clock, metrics


def test_the_first_request_does_not_wait_for_the_clis_and_says_the_quota_is_being_collected(tmp_path):
    quota, collector, _, _ = make(tmp_path, background=True)
    collector.gate = threading.Event()  # the CLIs are slow
    body = quota.view()
    assert body["generated_at"] is None and body["providers"]["claude"]["reason"] == PENDING
    quota.view()  # a second poll while it runs does not start another run
    assert collector.calls == 1
    collector.gate.set()
    quota._thread.join(5)
    assert quota.view()["providers"]["claude"]["windows"]["5h"]["used_pct"] == 40.0


def test_a_fresh_snapshot_is_served_and_an_old_one_is_replaced_in_the_background(tmp_path):
    quota, collector, clock, metrics = make(tmp_path)
    quota.view()
    clock.now += timedelta(minutes=14)
    quota.view()
    assert collector.calls == 1
    clock.now += timedelta(minutes=2)
    assert quota.view()["generated_at"] == START.isoformat()  # the old one is served while the new one is made
    assert collector.calls == 2
    assert quota.view()["generated_at"] == (START + timedelta(minutes=16)).isoformat()
    assert metrics.snapshot()["counters"]["agents_quota_refreshes"] == 2 and "agents_quota_collect" in metrics.snapshot()["timings"]


def test_a_collector_that_cannot_make_a_snapshot_shows_why_and_is_not_retried_every_poll(tmp_path):
    quota, collector, clock, _ = make(tmp_path)
    collector.collect = lambda now: {"schema_version": 9}
    for _ in range(3):
        assert "unsupported schema" in quota.view()["providers"]["codex"]["reason"]
    clock.now += timedelta(minutes=2)
    quota.view()
    assert quota.error and not (tmp_path / "quota.json").exists()

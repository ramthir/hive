import subprocess
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.application.agents.usage import AgentUsage
from src.infrastructure.agents.usage_files import ReportStore
from src.application.agents.quota import AgentQuota
from src.domain.agents.quota import QuotaError, parse_snapshot
from tests.agent_reports import envelope, quota_snapshot


class FixedCollector:
    def collect(self, now):
        return envelope(now, since=now.replace(day=1).strftime("%Y-%m-%d"))


class FixedQuota:
    def collect(self, now):
        return quota_snapshot(now)


@pytest.fixture
def client(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(notes), *a], check=True, capture_output=True)
    usage = AgentUsage(ReportStore(tmp_path / "state" / "usage.json"), FixedCollector())
    quota = AgentQuota(ReportStore(tmp_path / "state" / "quota.json", parse_snapshot, (QuotaError,), "quota snapshot"), FixedQuota(), background=False)
    with TestClient(create_app(notes, watch=False, agent_usage=usage, agent_quota=quota)) as c:
        yield c


def test_usage_has_a_card_per_provider(client):
    body = client.get("/api/agents/usage").json()
    assert body["status"] == "ok" and list(body["providers"]) == ["claude", "codex", "antigravity"]
    assert body["providers"]["claude"]["tokens"]["total"] > 0


def test_sessions_are_sorted_and_paged_by_the_server(client):
    body = client.get("/api/agents/usage/sessions", params={"sort": "total", "dir": "asc", "page_size": 2}).json()
    assert body["total"] == 3 and len(body["items"]) == 2 and body["sort"] == "total"
    totals = [s["tokens"]["total"] for s in body["items"]]
    assert totals == sorted(totals)
    assert client.get("/api/agents/usage/sessions", params={"page": 1, "page_size": 2}).json()["items"][0]["session"] == "sess-c"
    filtered = client.get("/api/agents/usage/sessions", params={"provider": "codex"}).json()
    assert filtered["total"] == 1 and filtered["items"][0]["provider"] == "codex"


@pytest.mark.parametrize("query", ["sort=name", "dir=up", "page=-1", "page_size=0", "page_size=51", "provider=unknown"])
def test_bad_options_are_422(client, query):
    assert client.get(f"/api/agents/usage/sessions?{query}").status_code == 422


@pytest.mark.parametrize("path", ["/dashboard", "/dashboard/agents"])
def test_each_dashboard_tab_has_its_own_address_on_one_page(client, path):
    r = client.get(path)
    assert r.status_code == 200 and "dashboard-app" in r.text


def test_there_is_no_separate_agents_page(client):
    assert client.get("/agents").status_code == 404


def test_the_refresh_shows_in_metrics(client):
    client.get("/api/agents/usage")
    metrics = client.get("/api/metrics").json()
    assert metrics["counters"]["agents_refreshes"] == 1 and metrics["timings"]["agents_collect"]["count"] == 1


def test_quota_has_the_windows_per_provider_and_never_waits_for_the_clis(client):
    body = client.get("/api/agents/quota").json()
    assert list(body["providers"]) == ["claude", "codex", "antigravity"]
    assert body["providers"]["claude"]["windows"]["5h"]["state"] == "ok"
    assert body["providers"]["antigravity"]["windows"]["argon-7d"]["used_pct"] == 0.0


def test_quota_refreshes_show_in_metrics(client):
    client.get("/api/agents/quota")
    assert client.get("/api/metrics").json()["counters"]["agents_quota_refreshes"] == 1

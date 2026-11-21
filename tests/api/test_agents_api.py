import subprocess
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.application.agents.usage import AgentUsage
from src.infrastructure.agents.usage_files import ReportStore
from tests.agent_reports import envelope


class FixedCollector:
    def collect(self, now):
        return envelope(now, since=now.replace(day=1).strftime("%Y-%m-%d"))


@pytest.fixture
def client(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(notes), *a], check=True, capture_output=True)
    usage = AgentUsage(ReportStore(tmp_path / "state" / "usage.json"), FixedCollector())
    with TestClient(create_app(notes, watch=False, agent_usage=usage)) as c:
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


@pytest.mark.parametrize("query", ["sort=name", "dir=up", "page=-1", "page_size=0", "page_size=51"])
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

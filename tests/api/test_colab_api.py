import asyncio
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.api.routes import colab as colab_routes
from src.application.colab.collector import ColabCollector, RuntimeFeed
from src.domain.colab.errors import ColabCliError

SESSION = {"name": "sentinel-run", "runtime_id": "m-s-1", "hardware": "CPU", "shape": "Standard", "variant": "DEFAULT"}
STATS = {"cpu_count": 2, "cpu_percent": 12.5, "memory": {"used_gb": 1.0, "total_gb": 12.0, "percent": 8.3}}
USAGE = {"balance": 499.97, "balance_unit": "compute units", "usage_rate": 0.08, "usage_rate_unit": "/hr", "active_assignments": 1}


def process(pid, cpu, mem=1.0):
    return {"pid": pid, "name": f"p{pid}", "cmdline": "", "command": f"p{pid}", "running_for": "01:00", "cpu_percent": cpu, "mem_percent": mem, "mem": "1 MB", "status": "running"}


def make_collector():
    return ColabCollector(sessions=AsyncMock(return_value=[SESSION]), kernel_state=AsyncMock(return_value="idle"), collect=AsyncMock())


def feed(collector, **data):
    item = RuntimeFeed(SESSION)
    item.data.update(data)
    collector.feeds[SESSION["runtime_id"]] = item
    return item


@pytest.fixture
def collector():
    return make_collector()


@pytest.fixture
def sessions(monkeypatch):
    """What `colab sessions` says; set `sessions.value` to a list, or an exception to raise."""
    box = SimpleNamespace(value=[SESSION])

    async def read():
        if isinstance(box.value, Exception):
            raise box.value
        return box.value
    monkeypatch.setattr(colab_routes, "get_colab_sessions", read)
    return box


@pytest.fixture
def client(tmp_path, collector, sessions, monkeypatch):
    monkeypatch.setattr(colab_routes, "get_colab_usage", AsyncMock(return_value=USAGE))
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    colab_routes._stats_cache.clear()
    colab_routes._processes_cache.clear()
    with TestClient(create_app(tmp_path, watch=False, colab=collector)) as c:
        yield c


def test_health_and_usage(client):
    assert client.get("/api/colab/health").json() == {"reachable": True}
    assert client.get("/api/colab/usage").json() == {"reachable": True, **USAGE}


def test_usage_failure_is_reported_not_raised(client, monkeypatch):
    monkeypatch.setattr(colab_routes, "get_colab_usage", AsyncMock(side_effect=ColabCliError("colab CLI is not installed or not on PATH")))
    body = client.get("/api/colab/usage").json()
    assert body["reachable"] is False and "not installed" in body["error"]


def test_sessions_are_listed_and_a_cli_failure_is_an_empty_list_with_the_reason(client, sessions):
    assert client.get("/api/colab/sessions").json() == {"reachable": True, "sessions": [SESSION]}
    sessions.value = ColabCliError("colab sessions timed out")
    assert client.get("/api/colab/sessions").json() == {"reachable": False, "sessions": [], "error": "colab sessions timed out"}


def test_stats_with_no_runtime_say_so_and_never_start_one(client, sessions, collector):
    sessions.value = []
    body = client.get("/api/colab/stats").json()
    assert body == {"reachable": True, "active": False, "session": None, "error": "No active session"}
    assert client.get("/api/colab/stats", params={"session": "other"}).json()["error"] == "No active session"
    sessions.value = [SESSION]
    assert client.get("/api/colab/stats", params={"session": "other"}).json()["error"] == "Session 'other' is not active"
    collector.collect.assert_not_awaited()


def test_a_bad_session_name_is_a_400_before_anything_runs(client, collector):
    for route in ("stats", "processes", "stream"):
        assert client.get(f"/api/colab/{route}", params={"session": "bad;name"}).status_code == 400
    collector.kernel_state.assert_not_awaited()


def test_stats_come_from_what_the_collector_collected_and_never_start_a_probe(client, collector):
    first = client.get("/api/colab/stats").json()  # nothing collected yet: waiting, not an error
    assert first["busy"] is True and first["active"] is True and "waiting for next refresh" in first["message"]
    feed(collector, stats=STATS, processes=[process(1, 5.0)])
    body = client.get("/api/colab/stats", params={"session": "sentinel-run"}).json()
    assert body["busy"] is False and body["session"] == SESSION and body["cpu_count"] == 2
    collector.collect.assert_not_awaited()
    collector.kernel_state.assert_not_awaited()


def test_stats_keep_the_last_good_values_while_the_collector_waits(client, collector):
    item = feed(collector, stats=STATS)
    assert client.get("/api/colab/stats").json()["cpu_count"] == 2
    item.data["stats"] = None
    body = client.get("/api/colab/stats").json()
    assert body["busy"] is True and body["cpu_count"] == 2  # the previous answer, marked busy


def test_processes_are_sorted_and_paged_from_the_collected_list(client, collector):
    feed(collector, stats=STATS, processes=[process(10, 1.0, 9.0), process(11, 50.0, 1.0), process(12, 20.0, 5.0), process(13, 20.0, 5.0)])
    body = client.get("/api/colab/processes", params={"page_size": 2}).json()
    assert [p["pid"] for p in body["processes"]] == [11, 12] and body["total"] == 4 and body["total_pages"] == 2
    body = client.get("/api/colab/processes", params={"page_size": 2, "page": 2, "sort": "mem_percent", "direction": "asc"}).json()
    assert [p["pid"] for p in body["processes"]] == [10, 13] or [p["pid"] for p in body["processes"]] == [13, 10]
    assert client.get("/api/colab/processes", params={"page_size": 2, "page": 9}).json()["page"] == 2  # clamped to the last page


def test_processes_with_no_runtime_are_an_empty_page(client, sessions):
    sessions.value = []
    body = client.get("/api/colab/processes").json()
    assert body["active"] is False and body["processes"] == [] and body["total"] == 0 and body["page"] == 1


@pytest.mark.parametrize("query", ["sort=name", "direction=up", "page=0", "page_size=0", "page_size=101"])
def test_bad_process_options_are_422(client, query):
    assert client.get(f"/api/colab/processes?{query}").status_code == 422


def test_a_cli_failure_resolving_the_runtime_is_reported_for_stats_and_processes(client, sessions):
    sessions.value = ColabCliError("colab CLI is not installed or not on PATH")
    stats = client.get("/api/colab/stats").json()
    assert stats["reachable"] is False and "not installed" in stats["error"]
    processes = client.get("/api/colab/processes").json()
    assert processes["reachable"] is False and processes["processes"] == []


def test_the_stream_refuses_when_there_is_no_active_runtime(client, sessions, collector):
    sessions.value = []
    response = client.get("/api/colab/stream", params={"session": "sentinel-run"})
    assert response.status_code == 409 and "No active session" in response.json()["detail"]
    assert collector.feeds == {}  # nothing started


@pytest.mark.asyncio
async def test_a_viewer_gets_the_cached_event_first_and_leaving_stops_the_collector(monkeypatch):
    collector = ColabCollector(sessions=AsyncMock(return_value=[SESSION]), kernel_state=AsyncMock(return_value="busy"), collect=AsyncMock(), grace=0)
    monkeypatch.setattr(colab_routes, "get_colab_sessions", AsyncMock(return_value=[SESSION]))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(colab=collector)), is_disconnected=AsyncMock(return_value=False))
    response = await colab_routes.colab_stream(request, session="sentinel-run")
    assert response.media_type == "text/event-stream" and response.headers["x-accel-buffering"] == "no"
    stream = response.body_iterator
    assert await anext(stream) == "retry: 5000\n\n"
    assert "event: status" in await anext(stream)
    assert len(collector.feeds["m-s-1"].viewers) == 1
    await stream.aclose()
    assert not collector.feeds["m-s-1"].viewers
    await asyncio.sleep(0.05)
    assert collector.feeds["m-s-1"].task.done()  # the last viewer left, so nothing keeps probing
    await collector.shutdown()


def test_shutting_the_app_down_stops_a_running_collector(tmp_path, sessions):
    subprocess.run(["git", "-C", str(tmp_path), "init", "-q", "-b", "main"], check=True, capture_output=True)
    collector = ColabCollector(sessions=AsyncMock(return_value=[SESSION]), kernel_state=AsyncMock(return_value="busy"), collect=AsyncMock(), interval=3600)

    async def watch():
        async with collector.subscribe(SESSION):
            await asyncio.sleep(0.05)
            task = collector.feeds["m-s-1"].task
            assert not task.done()
            await collector.shutdown()
            assert task.done() and collector.feeds == {}
    asyncio.run(watch())

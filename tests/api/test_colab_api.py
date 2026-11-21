import asyncio
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.api.routes import colab as colab_routes
from src.application.colab.collector import ColabCollector
from src.domain.colab.errors import ColabCliError

SESSION = {"name": "sentinel-run", "runtime_id": "m-s-1", "hardware": "CPU", "shape": "Standard", "variant": "DEFAULT"}
USAGE = {"balance": 499.97, "balance_unit": "compute units", "usage_rate": 0.08, "usage_rate_unit": "/hr", "active_assignments": 1}


def make_collector():
    return ColabCollector(sessions=AsyncMock(return_value=[SESSION]), kernel_state=AsyncMock(return_value="idle"), collect=AsyncMock())


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


def test_a_bad_session_name_is_a_400_before_anything_runs(client, collector):
    assert client.get("/api/colab/stream", params={"session": "bad;name"}).status_code == 400
    collector.kernel_state.assert_not_awaited()


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


@pytest.mark.parametrize("route", ["stats", "processes"])
def test_the_stream_is_the_only_way_to_read_live_numbers(client, route):
    assert client.get(f"/api/colab/{route}").status_code == 404

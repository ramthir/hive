import os
import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app


@pytest.fixture
def client(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    with TestClient(create_app(tmp_path, watch=False)) as c:
        yield c


def test_stats_have_the_dashboard_cards(client):
    body = client.get("/api/system/stats").json()
    assert {"cpu", "memory", "load_average", "processes", "storage", "disk", "uptime", "app"} <= body.keys()
    assert {"total", "used", "free", "percent_used"} <= body["disk"].keys() and body["disk"]["total_bytes"] > 0
    assert body["app"]["pid"] == os.getpid()


def test_processes_are_paged_and_sorted(client):
    body = client.get("/api/system/processes", params={"page_size": 2, "sort": "mem_percent"}).json()
    assert len(body["processes"]) <= 2 and body["page"] == 1 and body["total"] >= 1
    assert {"pid", "name", "cmdline", "cpu_percent", "mem", "running_for"} <= body["processes"][0].keys()


@pytest.mark.parametrize("query", ["sort=name", "direction=up", "page=0", "page_size=0", "page_size=101"])
def test_bad_options_are_422(client, query):
    assert client.get(f"/api/system/processes?{query}").status_code == 422


def test_dashboard_page_is_served(client):
    r = client.get("/dashboard")
    assert r.status_code == 200 and "dashboard-app" in r.text

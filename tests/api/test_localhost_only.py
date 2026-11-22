import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.localhost import allowed_hosts, hostname
from src.api.main import create_app


@pytest.fixture
def client(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    return TestClient(create_app(tmp_path, watch=False))


@pytest.mark.parametrize("host", ["localhost", "localhost:80", "127.0.0.1:8080", "[::1]:80", "LOCALHOST", "testserver"])
def test_local_hosts_are_served(client, host):
    assert client.get("/api/health", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("host", ["192.168.1.5", "192.168.1.5:80", "notes.example.com", "localhost.evil.com", "evil.com:80", "", "[::2]"])
def test_other_hosts_are_refused(client, host):
    r = client.get("/api/health", headers={"host": host})
    assert r.status_code == 403


def test_foreign_origin_is_refused(client):
    assert client.post("/api/reindex", headers={"host": "localhost", "origin": "http://evil.com"}).status_code == 403
    assert client.get("/api/health", headers={"host": "localhost", "origin": "http://localhost:80"}).status_code == 200


def test_allowed_hosts_opt_in():
    assert allowed_hosts("") >= {"localhost", "127.0.0.1", "::1"}
    assert "hive.lan" in allowed_hosts("hive.lan, other")
    assert hostname("[::1]:80") == "::1"

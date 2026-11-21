import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.application.diagrams.service import DiagramService
from tests.application.test_diagram_service import FAKE_SVG, FakeRunner


@pytest.fixture
def root(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    return tmp_path


def client_with(root, runner=None, java=True):
    j = root / "java"
    j.write_text("")
    jar = root / "plantuml.jar"
    jar.write_text("")
    service = DiagramService(str(j) if java else None, jar, root, runner=runner or FakeRunner())
    return TestClient(create_app(root, watch=False, diagram_service=service))


def test_status_and_render(root):
    c = client_with(root)
    status = c.get("/api/diagram/status").json()
    assert status["available"] is True and status["reason"] is None and isinstance(status["graphviz"], bool)
    r = c.post("/api/diagram/render", json={"source": "@startuml\nA -> B\n@enduml"})
    assert r.status_code == 200 and r.json() == {"svg": FAKE_SVG}


def test_unavailable_is_a_503_with_the_reason(root):
    c = client_with(root, java=False)
    assert c.get("/api/diagram/status").json()["available"] is False
    r = c.post("/api/diagram/render", json={"source": "@startuml\nA -> B\n@enduml"})
    assert r.status_code == 503 and "Java" in r.json()["detail"]


def test_errors_map_to_http_statuses(root):
    c = client_with(root, runner=FakeRunner(stdout="", stderr="bad"))
    assert c.post("/api/diagram/render", json={"source": "@startuml\nA\n@enduml"}).status_code == 502
    assert c.post("/api/diagram/render", json={"source": "x" * 200_001}).status_code == 413
    assert c.post("/api/diagram/render", json={"source": ""}).status_code == 502
    assert c.post("/api/diagram/render", json={}).status_code == 422


def test_render_metrics(root):
    c = client_with(root)
    for _ in range(2):
        c.post("/api/diagram/render", json={"source": "@startuml\nA -> B\n@enduml"})
    m = c.get("/api/metrics").json()
    assert m["counters"]["diagram_cache_hits"] == 1 and m["timings"]["diagram_render"]["count"] == 1


def test_render_png(root):
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 20
    runner = FakeRunner()
    runner.stdout = ""
    c = client_with(root, runner=lambda cmd, data, env, timeout: subprocess.CompletedProcess(cmd, 0, png, b""))
    r = c.post("/api/diagram/render/png", json={"source": "@startuml\nA -> B\n@enduml", "theme": "light"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content.startswith(b"\x89PNG")
    assert c.post("/api/diagram/render/png", json={"source": "@startuml\nA\n@enduml", "theme": "blue"}).status_code == 422
    assert client_with(root, java=False).post("/api/diagram/render/png", json={"source": "A"}).status_code == 503

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


DOC = "# Arch\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n\ntext\n\n```puml\n@startuml\nC -> D\n@enduml\n```\n"


def note(c, content=DOC, title="Arch"):
    r = c.post("/api/notes", json={"title": title, "content": content})
    assert r.status_code == 201, r.text
    return r.json()


def test_embed_serves_the_nth_diagram_as_a_sandboxed_svg(root):
    c = client_with(root)
    note(c)
    r = c.get("/notes/arch/diagram.svg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/svg+xml" and r.text == FAKE_SVG
    assert r.headers["content-security-policy"].startswith("sandbox") and r.headers["x-content-type-options"] == "nosniff"
    assert c.get("/notes/arch/diagram.svg?n=2").status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_embed_with_a_version_is_kept_and_revalidates_by_etag(root):
    c = client_with(root)
    note(c)
    r = c.get("/notes/arch/diagram.svg?n=1&v=abc")
    assert "immutable" in r.headers["cache-control"]
    again = c.get("/notes/arch/diagram.svg", headers={"if-none-match": r.headers["etag"]})
    assert again.status_code == 304 and again.content == b""


def test_embed_errors(root):
    c = client_with(root)
    note(c)
    note(c, "# Plain\n\nno diagram\n", "Plain")
    assert c.get("/notes/missing/diagram.svg").status_code == 404
    r = c.get("/notes/arch/diagram.svg?n=3")
    assert r.status_code == 404 and "has 2 diagrams" in r.json()["detail"]
    assert "has no diagram" in c.get("/notes/plain/diagram.svg").json()["detail"]
    assert c.get("/notes/arch/diagram.svg?n=0").status_code == 422
    assert client_with(root, java=False).get("/notes/arch/diagram.svg").status_code == 503


def test_embed_png_and_the_note_page_still_works(root):
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 20
    c = client_with(root, runner=lambda cmd, data, env, timeout: subprocess.CompletedProcess(cmd, 0, png, b""))
    note(c)
    r = c.get("/notes/arch/diagram.png?theme=light")
    assert r.headers["content-type"] == "image/png" and "arch-1-light.png" in r.headers["content-disposition"]
    page = c.get("/notes/arch")
    assert page.status_code == 200 and "text/html" in page.headers["content-type"]


def test_embedding_note_follows_a_rename_and_blocks_delete(root):
    c = client_with(root)
    note(c)
    user = note(c, "# User\n\n![Arch](/notes/arch/diagram.svg?n=2)\n", "User")
    assert c.delete("/api/notes/arch").status_code == 409
    assert c.put("/api/notes/arch", json={"title": "Architecture"}).status_code == 200
    assert "(/notes/architecture/diagram.svg?n=2)" in c.get(f"/api/notes/{user['slug']}").json()["content"]

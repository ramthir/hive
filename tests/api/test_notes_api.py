import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def root(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    return tmp_path


@pytest.fixture
def client(root):
    return TestClient(create_app(root))


def make(client, title="Alpha", **kw):
    r = client.post("/api/notes", json={"title": title, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_requires_git_dir(tmp_path):
    with pytest.raises(RuntimeError):
        create_app(tmp_path)


def test_health(client, root):
    assert client.get("/api/health").json() == {"status": "ok", "notes_dir": str(root.resolve())}


def test_crud(client, root):
    n = make(client, "Alpha", content="hi", tags=["x"])
    assert n["slug"] == "alpha" and n["tags"] == ["x"] and n["content"] == "# Alpha\n\nhi"
    assert client.get("/api/notes/alpha").json()["content"] == "# Alpha\n\nhi"
    r = client.put("/api/notes/alpha", json={"content": "# Alpha\n\nbye"})
    assert r.json()["content"] == "# Alpha\n\nbye" and r.json()["tags"] == ["x"]
    assert [x["slug"] for x in client.get("/api/notes").json()] == ["alpha"]
    assert client.delete("/api/notes/alpha").status_code == 204
    assert client.get("/api/notes/alpha").status_code == 404
    assert git(root, "log", "--format=%s").splitlines() == ["doc: delete Alpha", "doc: update Alpha", "doc: add Alpha"]


def test_errors(client):
    make(client, "A")
    assert client.get("/api/notes/..%2Fx").status_code in (404, 422)
    assert client.put("/api/notes/missing", json={"content": "# x"}).status_code == 404
    assert client.get("/api/notes/a/versions/deadbeef").status_code == 404
    assert client.post("/api/notes", json={"content": "no heading and no title"}).status_code == 422
    assert client.post("/api/notes", json={"title": "  "}).status_code == 422
    assert client.put("/api/notes/a", json={"content": "# \n\ntext"}).status_code == 422
    assert client.post("/api/notes/a/rename", json={"slug": "b"}).status_code in (404, 405)  # no manual rename


def test_search_tags_and_filter(client):
    make(client, "Python tips", content="x", tags=["code"])
    make(client, "Other", content="python mention", tags=["misc"])
    hits = client.get("/api/notes", params={"q": "python"}).json()
    assert [h["slug"] for h in hits] == ["python-tips", "other"] and hits[0]["score"] > hits[1]["score"]
    assert [h["slug"] for h in client.get("/api/notes", params={"tag": "misc"}).json()] == ["other"]
    assert client.get("/api/tags").json() == {"code": 1, "misc": 1}


def test_backlinks_and_title_change_renames_the_file(client, root):
    make(client, "Target")
    make(client, "Linker", content="[[target]] [[Target]] [[nowhere]]")
    b = client.get("/api/notes/target/backlinks").json()
    assert [x["slug"] for x in b["backlinks"]] == ["linker"]
    assert client.get("/api/notes/linker/backlinks").json()["unresolved"] == ["nowhere"]
    assert client.get("/api/notes/linker/backlinks").json()["links"] == ["target"]
    r = client.put("/api/notes/target", json={"content": "# Goal\n\nnew"})
    assert r.json()["slug"] == "goal" and (root / "goal.md").exists() and not (root / "target.md").exists()
    assert client.get("/api/notes/target").status_code == 404
    assert client.get("/api/notes/linker").json()["content"].endswith("[[goal]] [[Goal]] [[nowhere]]")


def test_versions_diff_restore(client):
    make(client, "V", content="one\n")
    client.put("/api/notes/v", json={"content": "# V\n\none\ntwo\n"})
    vs = client.get("/api/notes/v/versions").json()
    assert [v["message"] for v in vs] == ["doc: update V", "doc: add V"]
    newest, oldest = vs[0]["sha"], vs[1]["sha"]
    d = client.get(f"/api/notes/v/versions/{newest[:8]}").json()
    assert d["content"] == "# V\n\none\ntwo\n" and d["title"] == "V"
    assert "+two" in client.get(f"/api/notes/v/versions/{newest}/diff").json()["diff"]
    assert "+one" in client.get(f"/api/notes/v/versions/{oldest}/diff").json()["diff"]
    cur = client.get(f"/api/notes/v/versions/{oldest}/diff", params={"against": "current"}).json()["diff"]
    assert "+two" in cur
    assert client.get(f"/api/notes/v/versions/{oldest}/diff", params={"against": "bad"}).status_code == 422
    r = client.post(f"/api/notes/v/versions/{oldest}/restore")
    assert r.json()["content"] == "# V\n\none\n"
    assert len(client.get("/api/notes/v/versions").json()) == 3


def test_external_edit_visible_after_reindex(client, root):
    make(client, "A")
    assert [n["slug"] for n in client.get("/api/notes").json()] == ["a"]  # builds the index
    (root / "b.md").write_text("---\ntitle: B\n---\n\nhi\n")
    assert [n["slug"] for n in client.get("/api/notes").json()] == ["a"]
    assert client.post("/api/reindex").status_code == 204
    assert [n["slug"] for n in client.get("/api/notes").json()] == ["a", "b"]


def test_resolve_and_snippet(client):
    make(client, "ADR: Standard", content="Some *body* text")
    r = client.get("/api/resolve", params=[("target", "adr-standard"), ("target", "ADR Standard"), ("target", "nope")]).json()
    assert r == {"adr-standard": {"slug": "adr-standard", "title": "ADR: Standard"},
                 "ADR Standard": {"slug": "adr-standard", "title": "ADR: Standard"}, "nope": None}
    assert client.get("/api/notes").json()[0]["snippet"] == "ADR: Standard Some body text"


def test_spa_and_static_served(client):
    for path in ("/", "/notes", "/notes/some-slug"):
        r = client.get(path)
        assert r.status_code == 200 and "<notes-app" in r.text
    assert client.get("/static/tokens.css").status_code == 200
    assert client.get("/api/nothing").status_code == 404


def test_latest(client, root):
    assert client.get("/api/latest").status_code == 404
    make(client, "First")
    make(client, "Second")
    assert client.get("/api/latest").json()["slug"] == "second"
    client.put("/api/notes/first", json={"content": "# First\n\nedited"})
    assert client.get("/api/latest").json()["slug"] == "first"


def test_notes_without_a_heading_show_their_title_as_one(client, root):
    (root / "legacy.md").write_text("---\ntitle: Legacy Note\n---\n\nplain body\n")
    assert client.get("/api/notes/legacy").json()["content"] == "# Legacy Note\n\nplain body\n"
    assert (root / "legacy.md").read_text().endswith("plain body\n")  # nothing is written until the next save
    client.put("/api/notes/legacy", json={"content": client.get("/api/notes/legacy").json()["content"]})
    assert "# Legacy Note" in (root / "legacy.md").read_text()


def test_list_recent_first(client):
    make(client, "First")
    make(client, "Second")
    assert [n["slug"] for n in client.get("/api/notes", params={"sort": "recent"}).json()] == ["second", "first"]
    assert [n["slug"] for n in client.get("/api/notes").json()] == ["first", "second"]
    assert client.get("/api/notes", params={"sort": "bogus"}).status_code == 422


def test_type_in_the_api(client, root):
    n = make(client, "Typed", type="task")
    assert n["type"] == "task"
    assert make(client, "Untyped")["type"] is None
    assert client.put("/api/notes/typed", json={"content": "# Typed\n\nedited"}).json()["type"] == "task"
    assert client.put("/api/notes/typed", json={"type": "contact"}).json()["type"] == "contact"
    assert client.get("/api/types").json() == {"contact": 1}
    assert [x["type"] for x in client.get("/api/notes").json()] == ["contact", None]
    assert client.put("/api/notes/typed", json={"type": ""}).json()["type"] is None
    assert client.get("/api/types").json() == {}
    assert "type:" not in (root / "typed.md").read_text()

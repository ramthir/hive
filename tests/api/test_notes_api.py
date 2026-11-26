import subprocess
from datetime import date

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.domain.notes.tasks import week_label


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


def test_a_note_that_others_link_to_cannot_be_deleted(client, root):
    make(client, "Target")
    make(client, "Linker", content="see [[target]]")
    r = client.delete("/api/notes/target")
    assert r.status_code == 409 and "Linker" in r.json()["detail"] and (root / "target.md").exists()
    assert client.delete("/api/notes/linker").status_code == 204  # nothing links to it
    assert client.delete("/api/notes/target").status_code == 204  # the link is gone with its note


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


def test_versions_are_paged(client):
    make(client, "P", content="0\n")
    for i in range(1, 5):
        client.put("/api/notes/p", json={"content": f"# P\n\n{i}\n"})
    everything = client.get("/api/notes/p/versions").json()
    assert len(everything) == 5
    first = client.get("/api/notes/p/versions", params={"limit": 2}).json()
    rest = client.get("/api/notes/p/versions", params={"limit": 2, "offset": 2}).json()
    last = client.get("/api/notes/p/versions", params={"limit": 2, "offset": 4}).json()
    assert [v["sha"] for v in first + rest + last] == [v["sha"] for v in everything]
    assert len(last) == 1 and last[0]["added"] > 0 and all("added" in v for v in first)
    assert client.get("/api/notes/p/versions", params={"limit": 0}).status_code == 422


def test_versions_diff_restore(client):
    make(client, "V", content="one\n")
    client.put("/api/notes/v", json={"content": "# V\n\none\ntwo\n"})
    vs = client.get("/api/notes/v/versions").json()
    assert [v["message"] for v in vs] == ["doc: update V", "doc: add V"]
    assert vs[0]["added"] >= 1 and vs[0]["removed"] >= 0 and vs[1]["added"] > 0
    assert (vs[0]["kind"], vs[0]["summary"]) == ("text", "Edited text") and vs[1]["kind"] == "created"
    newest, oldest = vs[0]["sha"], vs[1]["sha"]
    d = client.get(f"/api/notes/v/versions/{newest[:8]}").json()
    assert d["content"] == "# V\n\none\ntwo\n" and d["title"] == "V"
    assert "+two" in client.get(f"/api/notes/v/versions/{newest}/diff").json()["diff"]
    assert "+one" in client.get(f"/api/notes/v/versions/{oldest}/diff").json()["diff"]
    cur = client.get(f"/api/notes/v/versions/{oldest}/diff", params={"against": "current"}).json()["diff"]
    assert "+two" in cur
    assert client.get(f"/api/notes/v/versions/{oldest}/diff", params={"against": "bad"}).status_code == 422
    # A save that only touches the frontmatter still shows what changed.
    client.put("/api/notes/v", json={"tags": ["fresh"]})
    tagged = client.get("/api/notes/v/versions").json()[0]["sha"]
    meta = client.get(f"/api/notes/v/versions/{tagged}/diff").json()
    assert meta["diff"] == "" and {"key": "tags", "old": None, "new": "fresh", "minor": False} in meta["properties"]
    assert (meta["index"], meta["total"]) == (1, 3) and meta["version_title"] == meta["current_title"] == "V"
    since = client.get(f"/api/notes/v/versions/{oldest}/diff", params={"against": "current"}).json()
    assert "+two" in since["diff"] and any(p["key"] == "tags" for p in since["properties"]) and since["index"] == 3
    r = client.post(f"/api/notes/v/versions/{oldest}/restore")
    assert r.json()["content"] == "# V\n\none\n"
    assert len(client.get("/api/notes/v/versions").json()) == 4


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
    assert r == {"adr-standard": {"slug": "adr-standard", "title": "ADR: Standard", "types": []},
                 "ADR Standard": {"slug": "adr-standard", "title": "ADR: Standard", "types": []}, "nope": None}
    assert client.get("/api/notes").json()[0]["snippet"] == "ADR: Standard Some body text"


def test_resolve_gives_the_types_so_a_page_can_link_to_the_read_page(client, root):
    (root / "weekly.md").write_text("---\ntitle: Weekly\ntype: [meeting, meeting-minutes]\n---\n\nhi\n")
    client.post("/api/reindex")
    r = client.get("/api/resolve", params=[("target", "Weekly")]).json()
    assert r["Weekly"]["types"] == ["meeting", "meeting-minutes"]


def test_spa_and_static_served(client):
    for path in ("/", "/notes", "/notes/some-slug"):
        r = client.get(path)
        assert r.status_code == 200 and "<notes-app" in r.text
    assert client.get("/static/tokens.css").status_code == 200
    assert client.get("/api/nothing").status_code == 404


def test_favicon_is_the_sidebar_logo(client):
    """The tab icon is the sidebar's circle-nodes glyph in the accent colour, as an SVG and as a multi-size ICO."""
    svg = client.get("/static/favicon.svg")
    assert svg.status_code == 200 and "#ff6188" in svg.text and "<path" in svg.text
    assert "--color-accent1: #ff6188" in client.get("/static/tokens.css").text  # the colour the logo uses
    assert "fa-circle-nodes" in client.get("/static/sidebar.js").text
    ico = client.get("/static/favicon.ico").content
    count = int.from_bytes(ico[4:6], "little")
    sizes = {(ico[6 + 16 * i] or 256, ico[7 + 16 * i] or 256) for i in range(count)}
    assert ico[:4] == b"\x00\x00\x01\x00" and {(16, 16), (32, 32), (256, 256)} <= sizes


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


def test_types_in_the_api(client, root):
    n = make(client, "Typed", types=["task", "urgent"])
    assert n["types"] == ["task", "urgent"]
    assert make(client, "Untyped")["types"] == []
    assert client.put("/api/notes/typed", json={"content": "# Typed\n\nedited"}).json()["types"] == ["task", "urgent"]
    assert client.put("/api/notes/typed", json={"types": ["contact"]}).json()["types"] == ["contact"]
    assert client.get("/api/types").json() == {"contact": 1}
    assert [x["types"] for x in client.get("/api/notes").json()] == [["contact"], []]
    assert client.put("/api/notes/typed", json={"types": []}).json()["types"] == []
    assert client.get("/api/types").json() == {}
    assert "type:" not in (root / "typed.md").read_text()


# -- task board ---------------------------------------------------------------

def seed_tasks(root):
    (root / "plain.md").write_text("---\ntitle: Plain\ntype: task\ntags: [todo]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Plain\n")
    (root / "finished.md").write_text("---\ntitle: Finished\ntype: [task]\ntags: [done, x]\ncreated: 2026-01-01\nupdated: 2026-01-02\n---\n\n# Finished\n")
    (root / "going.md").write_text("---\ntitle: Going\ntype: task\nstatus: IN_PROGRESS\ntags: [done]\ncreated: 2026-01-01\nupdated: 2026-01-03\n---\n\n# Going\n")
    (root / "other.md").write_text("---\ntitle: Other\ntype: note\nstatus: ApplicationStatus\n---\n\n# Other\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "seed")


def test_tasks_lists_only_task_notes_with_an_effective_status(client, root):
    seed_tasks(root)
    rows = client.get("/api/tasks").json()
    assert [(t["slug"], t["status"]) for t in rows] == [("going", "IN_PROGRESS"), ("finished", "DONE"), ("plain", "TODO")]


def test_changing_status_rewrites_only_that_key_in_one_commit(client, root):
    seed_tasks(root)
    before = len(git(root, "rev-list", "HEAD").split())
    r = client.put("/api/notes/plain", json={"status": "DONE"})
    assert r.status_code == 200 and r.json()["status"] == "DONE"
    text = (root / "plain.md").read_text()
    week = week_label(date.today())
    assert text.startswith(f"---\ntitle: Plain\ntype: task\nstatus: DONE\nweek: {week}\ntags: [todo]\n")  # new keys after `type`
    assert len(git(root, "rev-list", "HEAD").split()) == before + 1
    assert {t["slug"]: t["status"] for t in client.get("/api/tasks").json()}["plain"] == "DONE"


def test_status_is_new_key_after_type_and_updates_in_place(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"status": "IN_PROGRESS"})
    assert "type: task\nstatus: IN_PROGRESS\ntags: [todo]\n" in (root / "plain.md").read_text()
    client.put("/api/notes/plain", json={"status": "DONE"})
    assert (root / "plain.md").read_text().count("status:") == 1


def test_saving_content_keeps_the_status(client, root):
    seed_tasks(root)
    client.put("/api/notes/going", json={"content": "# Going\n\nmore"})
    assert client.get("/api/notes/going").json()["status"] == "IN_PROGRESS"


def test_unknown_status_is_rejected(client, root):
    seed_tasks(root)
    assert client.put("/api/notes/plain", json={"status": "DOING"}).status_code == 422


def test_tasks_page_is_served(client):
    r = client.get("/tasks")
    assert r.status_code == 200 and "tasks-app" in r.text


def test_time_entries_page_is_served(client):
    r = client.get("/time-entries")
    assert r.status_code == 200 and "time-entries-app" in r.text
    assert client.get("/static/time-entries/time-page.js").status_code == 200


def test_finishing_a_task_records_the_week_and_leaving_done_clears_it(client, root):
    seed_tasks(root)
    week = week_label(date.today())
    assert client.put("/api/notes/plain", json={"status": "DONE"}).json()["week"] == week
    assert {t["slug"]: t["week"] for t in client.get("/api/tasks").json()}["plain"] == week
    assert client.put("/api/notes/plain", json={"status": "IN_PROGRESS"}).json()["week"] is None
    assert "week:" not in (root / "plain.md").read_text()


def test_a_week_given_with_the_status_wins_and_is_validated(client, root):
    seed_tasks(root)
    r = client.put("/api/notes/plain", json={"status": "DONE", "week": "2026-W40"})
    assert r.json()["week"] == "2026-W40" and "week: 2026-W40" in (root / "plain.md").read_text()
    assert client.put("/api/notes/plain", json={"week": "2026-W54"}).status_code == 422
    assert client.put("/api/notes/plain", json={"week": "last week"}).status_code == 422


def test_saving_content_keeps_the_week_and_a_done_tag_task_gets_one_when_finished(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"status": "DONE", "week": "2026-W40"})
    client.put("/api/notes/plain", json={"content": "# Plain\n\nedited"})
    assert client.get("/api/notes/plain").json()["week"] == "2026-W40"
    # `finished` is already Done through its tag, so re-saving DONE is not a transition: no week is invented
    client.put("/api/notes/finished", json={"status": "DONE"})
    assert client.get("/api/notes/finished").json()["week"] is None


def test_tasks_carry_their_week_and_say_whether_it_was_recorded(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"status": "DONE", "week": "2026-W40"})
    rows = {t["slug"]: t for t in client.get("/api/tasks").json()}
    assert (rows["plain"]["week_key"], rows["plain"]["week_stored"]) == ("2026-W40", True)
    assert (rows["finished"]["week_key"], rows["finished"]["week_stored"]) == ("2026-W01", False)  # from `updated: 2026-01-02`


def test_tasks_carry_the_time_logged_on_them(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain/time/2026-11-20", json={"minutes": 90})
    client.post("/api/notes/plain/time", json={"day": "2026-11-21", "minutes": 45})
    rows = {t["slug"]: t for t in client.get("/api/tasks").json()}
    assert rows["plain"]["logged_minutes"] == 135
    assert rows["finished"]["logged_minutes"] == 0


def test_current_week_is_the_servers(client):
    assert client.get("/api/tasks/current-week").json() == {"week": week_label(date.today())}


def test_tasks_expose_the_priority_apart_from_their_tags(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"priority": "important"})
    row = {t["slug"]: t for t in client.get("/api/tasks").json()}["plain"]
    assert (row["priority"], row["tags"]) == ("important", ["todo"])
    text = (root / "plain.md").read_text()
    assert "priority: important" in text and "tags: [todo]" in text  # its own key, not a tag
    assert client.get("/api/notes/plain").json()["tags"] == ["todo"]


def test_older_notes_with_a_priority_tag_still_show_it_until_the_key_is_set(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"tags": ["todo", "#must"]})
    row = {t["slug"]: t for t in client.get("/api/tasks").json()}["plain"]
    assert (row["priority"], row["tags"]) == ("must", ["todo"])
    client.put("/api/notes/plain", json={"priority": "important"})  # setting the key moves the priority out of the tags
    text = (root / "plain.md").read_text()
    assert "priority: important" in text and "must" not in text


def test_priority_replaces_or_clears_the_key_and_goes_with_tags_in_one_commit(client, root):
    seed_tasks(root)
    client.put("/api/notes/plain", json={"priority": "must"})
    before = len(git(root, "rev-list", "HEAD").split())
    r = client.put("/api/notes/plain", json={"tags": ["todo", "work", "#important"], "priority": "nice-to-have"})
    assert r.json()["tags"] == ["todo", "work"]  # a priority tag is dropped, whichever way it was written
    assert "priority: nice-to-have" in (root / "plain.md").read_text()
    assert len(git(root, "rev-list", "HEAD").split()) == before + 1
    assert client.put("/api/notes/plain", json={"priority": ""}).json()["tags"] == ["todo", "work"]
    assert "priority:" not in (root / "plain.md").read_text()
    assert client.put("/api/notes/plain", json={"priority": "urgent"}).status_code == 422
    # without `priority`, tags are taken as written
    assert client.put("/api/notes/plain", json={"tags": ["a"]}).json()["tags"] == ["a"]


# -- time ------------------------------------------------------------------
def test_logging_time_through_the_api(client, root):
    make(client, "Fix login", types=["task"])
    r = client.put("/api/notes/fix-login/time/2026-11-20", json={"minutes": 90})
    assert r.status_code == 200
    assert r.json() == {"id": "fix-login:2026-11-20", "slug": "fix-login", "title": "Fix login", "type": "task",
                        "project": "", "day": "2026-11-20", "minutes": 90}
    r = client.post("/api/notes/fix-login/time", json={"day": "2026-11-20", "minutes": 30})
    assert r.status_code == 201 and r.json()["minutes"] == 120
    assert client.get("/api/notes/fix-login").json()["time"] == {"2026-11-20": 120}
    assert "time: {2026-11-20: 120}" in (root / "fix-login.md").read_text()
    assert client.delete("/api/notes/fix-login/time/2026-11-20").status_code == 204
    assert client.get("/api/notes/fix-login").json()["time"] == {}
    assert client.delete("/api/notes/fix-login/time/2026-11-20").status_code == 404


def test_moving_time_through_the_api(client):
    make(client, "Fix login", types=["task"])
    make(client, "Write docs", types=["task"])
    make(client, "Idea", types=["idea"])
    client.put("/api/notes/fix-login/time/2026-11-20", json={"minutes": 60})
    r = client.post("/api/notes/fix-login/time/2026-11-20/move", json={"slug": "write-docs", "day": "2026-11-21", "minutes": 45})
    assert r.status_code == 200 and r.json()["id"] == "write-docs:2026-11-21" and r.json()["minutes"] == 45
    assert client.get("/api/notes/fix-login").json()["time"] == {}
    assert client.post("/api/notes/fix-login/time/2026-11-20/move", json={"slug": "write-docs", "day": "2026-11-21", "minutes": 5}).status_code == 404
    assert client.post("/api/notes/write-docs/time/2026-11-21/move", json={"slug": "idea", "day": "2026-11-21", "minutes": 45}).status_code == 422


def test_a_note_says_whether_it_takes_time(client):
    make(client, "Fix login", types=["task"])
    make(client, "Idea", types=["idea"])
    assert client.get("/api/notes/fix-login").json()["takes_time"] is True
    assert client.get("/api/notes/idea").json()["takes_time"] is False


def test_logging_time_is_refused_for_bad_input(client):
    make(client, "Fix login", types=["task"])
    make(client, "Idea", types=["idea"])
    assert client.put("/api/notes/idea/time/2026-11-20", json={"minutes": 30}).status_code == 422
    assert client.put("/api/notes/fix-login/time/soon", json={"minutes": 30}).status_code == 422
    assert client.put("/api/notes/fix-login/time/2026-11-20", json={"minutes": 0}).status_code == 422
    assert client.put("/api/notes/fix-login/time/2026-11-20", json={"minutes": 1441}).status_code == 422
    assert client.put("/api/notes/missing/time/2026-11-20", json={"minutes": 30}).status_code == 404


def test_time_entries_lists_rows_with_the_month_totals(client):
    make(client, "Fix login", types=["task"])
    make(client, "Standup", types=["meeting"])
    today = date.today()
    this_month = today.replace(day=1).isoformat()
    client.put(f"/api/notes/fix-login/time/{this_month}", json={"minutes": 90})
    client.put("/api/notes/fix-login/time/2020-01-02", json={"minutes": 60})
    client.put(f"/api/notes/standup/time/{this_month}", json={"minutes": 15})
    body = client.get("/api/time-entries").json()
    assert [(i["slug"], i["day"], i["minutes"]) for i in body["items"]] == [
        ("fix-login", this_month, 90), ("standup", this_month, 15), ("fix-login", "2020-01-02", 60)]
    assert {k: body[k] for k in ("total", "total_entries", "total_minutes", "task_minutes", "meeting_minutes",
                                 "page", "page_size", "total_pages")} == {
        "total": 3, "total_entries": 2, "total_minutes": 105, "task_minutes": 90, "meeting_minutes": 15,
        "page": 0, "page_size": 10, "total_pages": 1}
    assert body["month"] == today.isoformat()[:7] and body["today"] == today.isoformat()
    assert [(d["day"], d["minutes"], [i["title"] for i in d["items"]]) for d in body["days"]] == [
        (this_month, 105, ["Fix login", "Standup"])]


@pytest.mark.parametrize(("project", "label", "slug"), [
    ("Acme", "Acme", "acme"),
    ("[[Acme|Client]]", "Client", "acme"),
    ("[[Missing]]", "Missing", None),
])
def test_time_entries_resolves_project_links(client, root, project, label, slug):
    today = date.today().isoformat()
    make(client, "Acme", types=["company"])
    (root / "fix-login.md").write_text(
        f"---\ntype: task\nproject: '{project}'\ntime: {{{today}: 30}}\n---\n# Fix login\n"
    )
    client.post("/api/reindex")
    body = client.get("/api/time-entries").json()
    [entry] = body["items"]
    assert (entry["project"], entry["project_label"], entry["project_slug"]) == (project, label, slug)
    assert body["days"][0]["items"][0]["project"] == label


def test_time_entries_filters_and_pages(client):
    make(client, "Fix login", types=["task"])
    make(client, "Standup", types=["meeting"])
    for d in range(1, 6):
        client.put(f"/api/notes/fix-login/time/2026-01-0{d}", json={"minutes": 10 * d})
    client.put("/api/notes/standup/time/2026-01-03", json={"minutes": 5})
    assert len(client.get("/api/time-entries", params={"q": "stand"}).json()["items"]) == 1
    assert len(client.get("/api/time-entries", params={"q": "duration:>=2h"}).json()["items"]) == 0
    assert len(client.get("/api/time-entries", params={"q": "duration:>=30m"}).json()["items"]) == 3
    assert len(client.get("/api/time-entries", params={"start": "2026-01-02", "end": "2026-01-03"}).json()["items"]) == 3
    assert len(client.get("/api/time-entries", params={"note": "standup"}).json()["items"]) == 1
    p = client.get("/api/time-entries", params={"page": 1, "page_size": 4}).json()
    assert (len(p["items"]), p["total"], p["total_pages"]) == (2, 6, 2)
    assert client.get("/api/time-entries", params={"start": "2026-02-01", "end": "2026-01-01"}).status_code == 400


def test_time_on_a_note_that_is_not_a_task_or_meeting_stays_visible_as_other(client, root):
    (root / "idea.md").write_text("---\ntitle: Idea\ntype: idea\ntime: {2026-01-01: 30}\n---\n\n# Idea\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "seed")
    client.post("/api/reindex")
    items = client.get("/api/time-entries").json()["items"]
    assert [(i["slug"], i["type"]) for i in items] == [("idea", "other")]
    assert client.get("/api/time-notes").json() == []  # but it cannot be picked for new time
    assert client.delete("/api/notes/idea/time/2026-01-01").status_code == 204


def test_time_notes_lists_tasks_and_meetings_this_weeks_first(client, root):
    for name, kind, updated in [("old", "task", "2020-01-01"), ("idea", "idea", "2020-01-01")]:
        (root / f"{name}.md").write_text(f"---\ntitle: {name.title()}\ntype: {kind}\nupdated: {updated}\n---\n\n# {name.title()}\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "seed")
    make(client, "Fresh", types=["meeting"])  # created now, so edited this week
    client.post("/api/reindex")
    assert client.get("/api/time-notes").json() == [
        {"slug": "fresh", "title": "Fresh", "type": "meeting", "this_week": True},
        {"slug": "old", "title": "Old", "type": "task", "this_week": False}]


def test_tables_page_is_its_own_document(client):
    res = client.get("/tables/anything")
    assert res.status_code == 200
    assert "<tables-app>" in res.text


def test_timelines_page_is_its_own_document(client):
    res = client.get("/timelines/anything")
    assert res.status_code == 200
    assert "<timelines-app>" in res.text


def test_specifications_page_is_its_own_document(client):
    res = client.get("/specifications/anything")
    assert res.status_code == 200
    assert "<specifications-app>" in res.text


def test_task_page_is_its_own_document(client):
    res = client.get("/tasks/anything")
    assert res.status_code == 200
    assert "<task-note-app>" in res.text
    assert client.get("/tasks").text != res.text  # the board is another document


def test_a_task_note_carries_its_effective_status_and_priority(client):
    make(client, "Old one", types=["task"], tags=["done", "Must"])  # an older note: only tags say so
    make(client, "New one", types=["task"])
    assert client.put("/api/notes/new-one", json={"status": "IN_PROGRESS", "priority": "nice-to-have"}).status_code == 200
    make(client, "Idea", types=["idea"], tags=["must"])
    old, new, idea = (client.get(f"/api/notes/{slug}").json() for slug in ("old-one", "new-one", "idea"))
    assert (old["task_status"], old["priority"]) == ("DONE", "must")
    assert (new["task_status"], new["priority"]) == ("IN_PROGRESS", "nice-to-have")
    assert (idea["task_status"], idea["priority"]) == (None, None)


def test_role_is_returned_as_plain_text_for_the_search(client, root):
    for slug, role in [("ann", "'[[Senior Engineer]]'"), ("bo", "'[[senior-engineer|Lead]]'"), ("cy", "UserRole"), ("dee", None)]:
        extra = f"role: {role}\n" if role else ""
        (root / f"{slug}.md").write_text(f"---\ntitle: {slug.title()}\ntype: contact\n{extra}---\n\n# {slug.title()}\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "contacts")
    roles = {n["slug"]: n["role"] for n in client.get("/api/notes").json()}
    assert roles == {"ann": "Senior Engineer", "bo": "Lead", "cy": "UserRole", "dee": None}
    assert client.get("/api/notes", params={"q": "Ann"}).json()[0]["role"] == "Senior Engineer"
    assert client.get("/api/notes/ann").json()["role"] == "Senior Engineer"


def test_a_save_based_on_an_old_revision_is_refused_and_writes_nothing(client, root):
    note = make(client, "Alpha", content="first")
    revision = note["revision"]
    assert revision and client.get("/api/notes/alpha").json()["revision"] == revision

    # The file is changed outside Hive (or by another tab) after this page read it.
    path = root / "alpha.md"
    path.write_text(path.read_text().replace("first", "changed elsewhere"))
    commits = git(root, "rev-list", "HEAD").split()
    r = client.put("/api/notes/alpha", json={"content": "# Alpha\n\nmy text", "revision": revision})
    assert r.status_code == 412 and "changed" in r.json()["detail"]
    assert "changed elsewhere" in path.read_text() and git(root, "rev-list", "HEAD").split() == commits

    # Reading again gives the new revision, and a save that names it goes through and returns the next one.
    fresh = client.get("/api/notes/alpha").json()["revision"]
    assert fresh != revision
    r = client.put("/api/notes/alpha", json={"content": "# Alpha\n\nmy text", "revision": fresh})
    assert r.status_code == 200 and r.json()["revision"] not in (revision, fresh)
    assert client.put("/api/notes/alpha", json={"content": "# Alpha\n\nmore", "revision": r.json()["revision"]}).status_code == 200


def test_a_save_without_a_revision_still_overwrites(client):
    make(client, "Alpha")
    assert client.put("/api/notes/alpha", json={"tags": ["x"]}).status_code == 200  # the task board and the drawers send none


def test_versions_can_be_filtered_by_kind_and_paged_after_filtering(client):
    make(client, "F", content="0\n", types=["task"])
    client.put("/api/notes/f", json={"status": "DONE"})  # properties
    for i in range(1, 4):
        client.put("/api/notes/f", json={"content": f"# F\n\n{i}\n"})  # text
    client.put("/api/notes/f/time/2026-11-20", json={"minutes": 30})  # time
    everything = client.get("/api/notes/f/versions").json()
    assert [v["kind"] for v in everything] == ["time", "text", "text", "text", "properties", "created"]

    text = client.get("/api/notes/f/versions", params={"kind": "text"}).json()
    assert [v["kind"] for v in text] == ["text"] * 3
    first = client.get("/api/notes/f/versions", params={"kind": "text", "limit": 2}).json()
    rest = client.get("/api/notes/f/versions", params={"kind": "text", "limit": 2, "offset": 2}).json()
    assert [v["sha"] for v in first + rest] == [v["sha"] for v in text]  # pages count matches, not commits
    assert [v["kind"] for v in client.get("/api/notes/f/versions", params={"kind": "time"}).json()] == ["time"]
    assert client.get("/api/notes/f/versions", params={"kind": "restore"}).json() == []
    assert client.get("/api/notes/f/versions", params={"kind": "nonsense"}).status_code == 422

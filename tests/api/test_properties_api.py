"""The note properties drawer: type-specific fields kept in frontmatter."""
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


def make(client, title, *types, **kw):
    r = client.post("/api/notes", json={"title": title, "types": list(types), **kw})
    assert r.status_code == 201, r.text
    return r.json()["slug"]


def form(client, slug):
    return {f["key"]: f for f in client.get(f"/api/notes/{slug}/properties").json()["fields"]}


def test_a_note_says_whether_its_type_has_properties(client):
    assert client.get(f"/api/notes/{make(client, 'Plain')}").json()["has_properties"] is False
    assert client.get(f"/api/notes/{make(client, 'Job', 'task')}").json()["has_properties"] is True
    assert client.get(f"/api/notes/{make(client, 'Idea', 'idea')}/properties").status_code == 404


def test_each_type_gets_its_own_fields(client):
    keys = lambda slug: list(form(client, slug))
    assert keys(make(client, "T", "task")) == ["project", "specification", "ticket", "status", "priority", "assignee", "week", "tags"]
    assert keys(make(client, "M", "meeting")) == ["week", "project"]
    assert keys(make(client, "Mm", "meeting-minutes")) == ["series", "project"]
    assert keys(make(client, "P", "project")) == ["billing"]
    assert keys(make(client, "Co", "company")) == ["billing"]
    assert keys(make(client, "C", "contact")) == ["role", "project", "team", "billing", "acting_for"]
    assert keys(make(client, "S", "spec")) == ["project", "application", "status", "verified"]
    assert keys(make(client, "Both", "meeting", "task"))[:2] == ["project", "specification"]  # a task and a meeting: the task's


def test_the_form_has_current_values_and_choices(client, root):
    make(client, "Acme", "project")
    make(client, "Zed Corp", "project")
    make(client, "Bo", "contact")
    make(client, "Not A Project")
    slug = make(client, "Job", "task", tags=["todo", "must"])
    client.put(f"/api/notes/{slug}", json={"properties": {"project": "Acme"}})
    f = form(client, slug)
    assert f["project"]["value"] == "Acme"
    assert [c["value"] for c in f["project"]["choices"]] == ["Acme", "Zed Corp"]
    assert [c["value"] for c in f["assignee"]["choices"]] == ["Bo"]
    assert (f["status"]["value"], f["priority"]["value"], f["week"]["value"]) == ("TODO", "must", "")
    assert f["tags"]["value"] == "todo"  # the priority tag is the Priority field
    assert [c["value"] for c in f["status"]["choices"]] == ["TODO", "IN_PROGRESS", "DONE"]
    this_week = week_label(date.today())
    assert this_week in [c["value"] for c in f["week"]["choices"]] and len(f["week"]["choices"]) == 5


def test_a_company_can_be_picked_as_the_project(client):
    make(client, "Acme", "project")
    make(client, "Big Co", "company")
    make(client, "Bo", "contact")
    for kind in ("task", "meeting", "contact", "spec", "prompt"):
        slug = make(client, f"Sample {kind}", kind)
        assert [c["value"] for c in form(client, slug)["project"]["choices"]] == ["Acme", "Big Co"], kind


def test_a_company_has_billing_like_a_project(client, root):
    slug = make(client, "Big Co", "company")
    f = form(client, slug)["billing"]
    assert [c["value"] for c in f["choices"]] == ["Billable", "Non Billable", "Prospecting"]
    assert client.put(f"/api/notes/{slug}", json={"properties": {"billing": "Prospecting"}}).status_code == 200
    assert "billing: Prospecting" in (root / "big-co.md").read_text()
    assert client.put(f"/api/notes/{slug}", json={"properties": {"billing": "Free"}}).status_code == 422


def test_a_value_typed_by_hand_stays_a_choice_and_so_does_a_far_off_week(client, root):
    slug = make(client, "Job", "task")
    path = root / "job.md"
    path.write_text(path.read_text().replace("type: task", "type: task\nproject: Big Co\nweek: 2026-W01"))
    f = form(client, slug)
    assert f["project"]["value"] == "Big Co" and [c["value"] for c in f["project"]["choices"]] == ["Big Co"]
    assert "2026-W01" in [c["value"] for c in f["week"]["choices"]]


def test_saving_properties_writes_frontmatter_in_one_commit(client, root):
    make(client, "Acme", "project")
    slug = make(client, "Job", "task")
    before = int(git(root, "rev-list", "--count", "HEAD"))
    r = client.put(f"/api/notes/{slug}", json={"status": "IN_PROGRESS", "priority": "must", "week": "2026-W40",
                                               "properties": {"project": "Acme", "assignee": "  Bo   Lee ", "ticket": " PROJ-12 "}})
    assert r.status_code == 200, r.text
    text = (root / "job.md").read_text()
    assert "project: Acme" in text and "ticket: PROJ-12" in text and "assignee: Bo Lee" in text and "status: IN_PROGRESS" in text and "week: 2026-W40" in text
    assert int(git(root, "rev-list", "--count", "HEAD")) == before + 1
    assert r.json()["extra"] == {"project": "Acme", "assignee": "Bo Lee", "ticket": "PROJ-12"}
    assert form(client, slug)["priority"]["value"] == "must"


def test_an_empty_value_removes_the_key_and_untouched_keys_stay_verbatim(client, root):
    slug = make(client, "Job", "task")
    path = root / "job.md"
    path.write_text(path.read_text().replace("type: task", "type: task\nproject: 'Big Co'\nowner: \"me\""))
    client.put(f"/api/notes/{slug}", json={"properties": {"assignee": "Bo"}})
    text = path.read_text()
    assert "project: 'Big Co'" in text and 'owner: "me"' in text  # quoting untouched
    client.put(f"/api/notes/{slug}", json={"properties": {"project": ""}})
    text = path.read_text()
    assert "project:" not in text and "assignee: Bo" in text and 'owner: "me"' in text


def test_an_empty_week_clears_it(client, root):
    slug = make(client, "Job", "task")
    client.put(f"/api/notes/{slug}", json={"week": "2026-W40"})
    assert client.put(f"/api/notes/{slug}", json={"week": ""}).json()["week"] is None
    assert "week:" not in (root / "job.md").read_text()


def test_unknown_keys_bad_choices_and_typeless_notes_are_refused(client, root):
    slug = make(client, "Job", "task")
    for bad in ({"owner": "x"}, {"status": "DONE"}, {"project": "x" * 300}):  # status is not a `property` field
        assert client.put(f"/api/notes/{slug}", json={"properties": bad}).status_code == 422
    plain = make(client, "Plain")
    assert client.put(f"/api/notes/{plain}", json={"properties": {"project": "x"}}).status_code == 422
    contact = make(client, "Bo", "contact")
    assert client.put(f"/api/notes/{contact}", json={"properties": {"billing": "Free"}}).status_code == 422
    assert "owner" not in (root / "job.md").read_text()


def test_acting_for_is_required_only_while_billing_is_shadowed_and_is_dropped_after(client, root):
    slug = make(client, "Bo", "contact")
    assert client.put(f"/api/notes/{slug}", json={"properties": {"billing": "Shadowed"}}).status_code == 422
    ok = {"billing": "Shadowed", "acting_for": "Al"}
    assert client.put(f"/api/notes/{slug}", json={"properties": ok}).status_code == 200
    assert "acting_for: Al" in (root / "bo.md").read_text()
    client.put(f"/api/notes/{slug}", json={"properties": {"billing": "Billable"}})
    text = (root / "bo.md").read_text()
    assert "acting_for" not in text and "billing: Billable" in text
    # editing another field of a billable contact never asks for Acting for
    assert client.put(f"/api/notes/{slug}", json={"properties": {"team": "Core"}}).status_code == 200


def test_changing_the_type_changes_which_fields_are_allowed(client):
    slug = make(client, "Bo", "contact")
    assert client.put(f"/api/notes/{slug}", json={"types": ["task"], "properties": {"assignee": "Al"}}).status_code == 200
    assert client.put(f"/api/notes/{slug}", json={"types": ["idea"], "properties": {"assignee": "Al"}}).status_code == 422


def test_saving_the_body_keeps_properties(client, root):
    slug = make(client, "Job", "task")
    client.put(f"/api/notes/{slug}", json={"properties": {"project": "Acme"}})
    client.put(f"/api/notes/{slug}", json={"content": "# Job\n\nmore"})
    assert "project: Acme" in (root / "job.md").read_text()


def test_tasks_board_carries_the_ticket_id_and_project(client):
    slug = make(client, "Job", "task")
    assert client.get("/api/tasks").json()[0]["ticket"] is None
    client.put(f"/api/notes/{slug}", json={"properties": {"ticket": "APIM-66", "project": "CreatorIQ"}})
    task = client.get("/api/tasks").json()[0]
    assert task["ticket"] == "APIM-66"
    assert task["project"] == "CreatorIQ"


def test_task_tags_are_saved_with_the_priority_in_one_request(client, root):
    slug = make(client, "Job", "task", tags=["todo", "must"])
    r = client.put(f"/api/notes/{slug}", json={"title": "Better job", "tags": ["todo", "work"], "priority": "must"})
    assert r.status_code == 200, r.text
    text = (root / "better-job.md").read_text()
    assert "priority: must" in text and "tags: [todo, work]" in text
    f = form(client, "better-job")
    assert (f["tags"]["value"], f["priority"]["value"]) == ("todo,work", "must")


def test_the_drawer_is_titled_for_the_type(client):
    title = lambda type_: client.get(f"/api/notes/{make(client, type_.title(), type_)}/properties").json()["title"]
    assert [title(t) for t in ("task", "meeting", "project", "contact", "spec", "prompt")] == [
        "Task Properties", "Meeting Properties", "Project Properties", "Contact Properties", "Spec Properties", "Prompt Properties"]


def test_task_tags_have_their_own_section(client):
    data = client.get(f"/api/notes/{make(client, 'Job', 'task')}/properties").json()
    assert data["groups"]["tags"] == "Tags"
    assert {f["key"]: f["group"] for f in data["fields"]}["tags"] == "tags"


def test_a_spec_picks_its_application_from_applications_and_projects(client):
    make(client, "Web App", "application")
    make(client, "SourcePro", "project")
    make(client, "Old Product", "product")
    slug = make(client, "A Spec", "spec")
    assert [c["value"] for c in form(client, slug)["application"]["choices"]] == ["SourcePro", "Web App"]


def test_a_contact_can_have_several_projects(client, root):
    make(client, "Acme", "project")
    make(client, "Zed Corp", "company")
    slug = make(client, "Jo", "contact")
    assert form(client, slug)["project"]["multiple"] is True
    r = client.put(f"/api/notes/{slug}", json={"properties": {"project": "Zed Corp, Acme,Acme"}})
    assert r.status_code == 200, r.text
    assert "project: [Zed Corp, Acme]" in (root / f"{slug}.md").read_text() or "- Acme" in (root / f"{slug}.md").read_text()
    f = form(client, slug)["project"]
    assert f["value"] == "Zed Corp,Acme"
    assert [c["value"] for c in f["choices"]] == ["Acme", "Zed Corp"]
    client.put(f"/api/notes/{slug}", json={"properties": {"project": "Acme"}})  # back to one: a plain value
    assert "project: Acme" in (root / f"{slug}.md").read_text()
    client.put(f"/api/notes/{slug}", json={"properties": {"project": ""}})
    assert "project" not in (root / f"{slug}.md").read_text()


def test_a_single_project_field_stays_single(client):
    slug = make(client, "Plan", "spec")
    assert form(client, slug)["project"]["multiple"] is False


def test_projects_written_as_wiki_links_are_read_as_titles_and_stay_links(client, root):
    make(client, "Acme", "project")
    make(client, "Zed Corp", "project")
    slug = make(client, "Jo", "contact")
    path = root / f"{slug}.md"
    path.write_text(path.read_text().replace("type:", "project: ['[[Acme]]', '[[Zed Corp]]']\ntype:", 1))
    client.post("/api/reindex")
    f = form(client, slug)["project"]
    assert f["value"] == "Acme,Zed Corp"
    assert [c["value"] for c in f["choices"]] == ["Acme", "Zed Corp"]
    client.put(f"/api/notes/{slug}", json={"properties": {"project": "Acme"}})
    assert "['[[Acme]]']" in path.read_text()


def test_role_offers_the_roles_other_contacts_have_and_accepts_new_ones(client, root):
    a, b = make(client, "Al", "contact"), make(client, "Bo", "contact")
    pa = root / f"{a}.md"
    pa.write_text(pa.read_text().replace("type:", "role: '[[Software Engineer]]'\ntype:", 1))
    client.post("/api/reindex")
    f = form(client, b)["role"]
    assert f["multiple"] is True and f["value"] == ""
    assert [c["value"] for c in f["choices"]] == ["Software Engineer"]
    client.put(f"/api/notes/{b}", json={"properties": {"role": "Architect"}})
    assert "role: Architect" in (root / f"{b}.md").read_text()
    client.put(f"/api/notes/{a}", json={"properties": {"role": "Lead Engineer"}})
    assert "role: '[[Lead Engineer]]'" in pa.read_text()  # a note that used links keeps using them
    assert form(client, b)["role"]["value"] == "Architect"


def test_a_specification_has_a_status_of_its_own_and_a_verified_date(client, root):
    slug = make(client, "Spine - Users", "specification")
    f = form(client, slug)
    assert f["status"]["value"] == ""  # a task would read TODO here; a specification has none until one is chosen
    assert [c["value"] for c in f["status"]["choices"]] == ["Draft", "Active", "Deprecated"]
    r = client.put(f"/api/notes/{slug}", json={"status": "Active", "properties": {"verified": "2026-11-20"}})
    assert r.status_code == 200, r.text
    text = (root / "spine-users.md").read_text()
    assert "status: Active" in text and "verified: '2026-11-20'" in text  # text, so quoted; the vault's own unquoted date reads the same
    f = form(client, slug)
    assert (f["status"]["value"], f["verified"]["value"]) == ("Active", "2026-11-20")
    (root / "spine-users.md").write_text(text.replace("verified: '2026-11-20'", "verified: 2026-11-21"))
    assert client.post("/api/reindex").status_code == 204
    assert form(client, slug)["verified"]["value"] == "2026-11-21"
    assert client.get(f"/api/notes/{slug}").json()["extra"]["verified"] == "2026-11-21"
    assert client.get("/api/tasks").json() == []  # Active is not a task status: the board never sees it


def test_a_task_refuses_a_specification_status(client):
    slug = make(client, "Job", "task")
    assert client.put(f"/api/notes/{slug}", json={"status": "Active"}).status_code == 422

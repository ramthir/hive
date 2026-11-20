"""End-to-end UI flows against a real server and a temp notes repo."""
import socket
from datetime import date
import subprocess
import threading
import time

import pytest
import uvicorn

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from src.api.main import create_app  # noqa: E402

pytestmark = pytest.mark.browser


def wait_for_commits(root, count, timeout=10):
    """Saves are asynchronous (write + git commit); wait until the repo has `count` commits."""
    end = time.time() + timeout
    while time.time() < end:
        if len(git(root, "rev-list", "HEAD").split()) >= count:
            return
        time.sleep(0.1)
    raise AssertionError(f"expected {count} commits, got {len(git(root, 'rev-list', 'HEAD').split())}")


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def notes_dir(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    (tmp_path / "alpha.md").write_text("---\ntitle: Alpha\ntags:\n  - one\ncreated: 2026-01-01\nupdated: 2026-02-02\n---\n\n# Alpha\n\nSee [[beta]] and [[Nope]].\n\n```python\nprint(1)\n```\n")
    (tmp_path / "beta.md").write_text("---\ntitle: Beta Note\ntags:\n  - two\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\nBeta body text\n")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-qm", "seed")
    return tmp_path


@pytest.fixture
def server(notes_dir):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def page(server):
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:  # browser binaries not installed
            pytest.skip(f"chromium unavailable: {exc}")
        pg = browser.new_page(viewport={"width": 1400, "height": 900})
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
        yield pg
        browser.close()


def test_root_opens_the_latest_note_and_there_is_no_list_page(page, server):
    page.goto(server)
    page.wait_for_url("**/notes/alpha")  # alpha has the newest `updated` date
    expect(page.locator("#notes-md h1")).to_have_text("Alpha")
    assert page.locator(".note-card, #notes-grid, #notes-tag-bar").count() == 0
    page.goto(f"{server}/notes")
    page.wait_for_url("**/notes/alpha")
    assert page.errors == []


def test_empty_notes_repo_opens_a_new_note(page, tmp_path_factory):
    empty = tmp_path_factory.mktemp("empty")
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(empty, *a)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(empty), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    try:
        page.goto(f"http://127.0.0.1:{port}/")
        page.wait_for_url("**/notes/new")
        page.wait_for_selector(".cm-content")
    finally:
        srv.should_exit = True
        thread.join(5)


def test_spotlight_lists_recent_notes_then_filters(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("app-header")).to_have_count(1)
    page.keyboard.press("Control+k")
    rows = page.locator("note-spotlight .spotlight-item")
    expect(rows).to_have_count(2)
    expect(rows.first).to_contain_text("Alpha")  # most recently edited first
    page.fill("note-spotlight .spotlight-input", "beta body")
    expect(rows).to_have_count(1)
    expect(rows.first).to_contain_text("Beta Note")
    page.keyboard.press("Enter")
    page.wait_for_url("**/notes/beta")
    expect(page.locator("note-spotlight .spotlight-backdrop")).to_be_hidden()
    expect(page).to_have_title("Beta Note - Hive")
    # The action bar's search button opens it too, and Escape closes it.
    page.click("#search-notes-btn")
    expect(page.locator("note-spotlight .spotlight-backdrop")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.locator("note-spotlight .spotlight-backdrop")).to_be_hidden()
    assert page.errors == []



def test_view_note_resolves_links_and_backlinks(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("#notes-md h1")).to_have_text("Alpha")
    good = page.locator('.notes-wikilink[data-target="beta"]')
    expect(good).to_have_text("Beta Note")  # auto-label replaced by the target's title
    expect(good).to_have_attribute("href", "/notes/beta")
    expect(page.locator('.notes-wikilink[data-target="Nope"]')).to_have_class("notes-wikilink unresolved")
    expect(page.locator(".notes-copy-code-btn")).to_have_count(1)
    expect(page.locator("#notes-backlinks")).to_contain_text("Broken links")
    good.click()
    page.wait_for_url("**/notes/beta")
    expect(page.locator("#notes-md h1")).to_have_text("Beta Note")  # beta has no heading on disk: its title is shown as one
    expect(page.locator("#notes-backlinks")).to_contain_text("Alpha")
    assert page.errors == []


def test_edit_save_commits_to_git_and_writes_the_heading(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type("\n\nAdded line")
    expect(page.locator("#notes-md")).to_contain_text("Added line")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    expect(page.locator("#save-note-btn")).to_be_disabled()
    text = (notes_dir / "beta.md").read_text()
    assert "Added line" in text and "\n# Beta Note\n" in text  # the title is now the first heading in the file
    assert git(notes_dir, "log", "-1", "--format=%s").strip() == "doc: update Beta Note"
    assert page.errors == []


def test_new_note_title_rename_history_restore_delete(page, server, notes_dir):
    page.goto(f"{server}/notes/new")
    page.wait_for_selector(".cm-content")
    page.keyboard.type("Fresh Idea\n\nfirst")  # the caret starts after "# " on the heading line
    page.keyboard.press("Control+s")
    page.wait_for_url("**/notes/fresh-idea?mode=edit")
    wait_for_commits(notes_dir, 2)  # seed + the new note
    assert (notes_dir / "fresh-idea.md").read_text().split("---\n\n", 1)[1].startswith("# Fresh Idea\n\nfirst")

    # Changing the heading renames the file (kebab-case of the new title).
    page.click(".cm-content")
    page.keyboard.press("Control+Home")
    page.keyboard.press("Shift+End")
    page.keyboard.type("# Renamed Idea")
    page.keyboard.press("Control+s")
    page.wait_for_url("**/notes/renamed-idea?mode=edit")
    expect(page.locator("#save-note-btn")).to_be_disabled()
    assert (notes_dir / "renamed-idea.md").exists() and not (notes_dir / "fresh-idea.md").exists()
    expect(page.locator(".notes-type-label")).to_have_attribute("title", "renamed-idea.md")  # the file name is the tooltip

    # History follows the file; restoring the first version brings back the old title and file name.
    page.click("#note-versions-btn")
    rows = page.locator(".hive-version-row")
    expect(rows).to_have_count(3)  # added, renamed, updated
    rows.nth(2).click()
    expect(page.locator(".hive-diff .add").first).to_be_visible()
    page.click("#version-restore")
    page.click("[data-action=confirm]")
    page.wait_for_url("**/notes/fresh-idea**")
    assert (notes_dir / "fresh-idea.md").exists() and not (notes_dir / "renamed-idea.md").exists()
    expect(page.locator("#notes-md h1")).to_have_text("Fresh Idea")

    page.click("#delete-note-btn")
    page.click("[data-action=confirm]")
    page.wait_for_url(lambda url: "fresh-idea" not in url)  # lands on the latest remaining note
    assert not (notes_dir / "fresh-idea.md").exists()
    assert git(notes_dir, "log", "-1", "--format=%s").strip() == "doc: delete Fresh Idea"
    assert page.errors == []


def test_saving_without_a_title_is_refused(page, server, notes_dir):
    page.goto(f"{server}/notes/new")
    page.wait_for_selector(".cm-content")
    page.keyboard.type("\nbody but no title")
    page.keyboard.press("Control+s")
    expect(page.locator(".notes-save-error-dialog-host")).to_contain_text("title")
    assert sorted(p.name for p in notes_dir.glob("*.md")) == ["alpha.md", "beta.md"]


def test_layout_and_hard_wrapped_paragraphs(page, notes_dir, server):
    (notes_dir / "wrapped.md").write_text("---\ntitle: Wrapped\n---\n\nfirst line of a paragraph\nwrapped onto a second line\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "wrapped")
    page.goto(f"{server}/notes/wrapped")
    expect(page.locator("#notes-md p")).to_have_count(1)
    assert page.locator("#notes-md p br").count() == 0  # a single newline is not a line break
    bar = page.locator(".notes-action-bar").bounding_box()
    sidebar = page.locator("app-sidebar .app-sidebar").bounding_box()
    assert abs(bar["x"] - sidebar["width"]) < 1  # the bar starts where the sidebar ends...
    assert abs(bar["x"] + bar["width"] - page.viewport_size["width"]) < 1  # ...and runs to the right edge


def test_tags_live_in_the_action_bar_and_save_to_frontmatter(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha")
    assert page.locator(".notes-meta-bar").count() == 0  # no extra bar above the note
    tags = page.locator(".notes-action-bar #note-tags")
    expect(tags).to_have_value("one")
    expect(tags).to_have_attribute("readonly", "")  # read-only until the note is being edited
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    tags.fill("one, two, three")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    text = (notes_dir / "alpha.md").read_text()
    assert "tags: [one, two, three]\n" in text  # changed, so written inline
    page.click("#edit-note-btn")  # close the editor: tags stay visible, read-only
    expect(tags).to_have_value("one, two, three")
    assert page.errors == []


def test_tag_field_is_hidden_for_untagged_notes_until_editing(page, server, notes_dir):
    (notes_dir / "plain.md").write_text("---\ntitle: Plain\n---\n\n# Plain\n\ntext\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "plain")
    page.goto(f"{server}/notes/plain")
    expect(page.locator("#note-tags")).to_be_hidden()
    page.click("#edit-note-btn")
    expect(page.locator("#note-tags")).to_be_visible()
    assert page.errors == []


def test_heading_starts_right_below_the_header(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("#notes-md h1")).to_be_visible()
    header = page.locator("app-header").bounding_box()
    workspace = page.locator(".notes-editor-workspace").bounding_box()
    assert abs(workspace["y"] - (header["y"] + header["height"])) < 2  # the note fills the space under the header
    assert page.locator("#notes-md h1").bounding_box()["y"] - workspace["y"] <= 24  # only the pane's own padding between them


def test_spotlight_navigation_keeps_unsaved_edits_safe(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("unsaved words")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+k")  # works while the editor has focus
    page.fill("note-spotlight .spotlight-input", "alpha")
    expect(page.locator("note-spotlight .spotlight-item")).to_have_count(1)  # wait for the results
    page.keyboard.press("Enter")
    page.click("[data-action=cancel]")  # "Leave this note without saving?" -> Cancel
    assert page.url.endswith("/notes/beta?mode=edit")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+k")
    page.fill("note-spotlight .spotlight-input", "alpha")
    expect(page.locator("note-spotlight .spotlight-item")).to_have_count(1)  # wait for the results
    page.keyboard.press("Enter")
    page.click("[data-action=confirm]")  # Discard
    page.wait_for_url("**/notes/alpha")
    assert "unsaved words" not in (notes_dir / "beta.md").read_text()
    assert page.errors == []


def test_there_is_no_new_note_button(page, server):
    page.goto(f"{server}/notes/alpha")
    assert page.locator("#add-note-btn").count() == 0
    expect(page.locator("#search-notes-btn")).to_be_visible()


def test_action_bar_shows_the_note_type_not_the_file_name(page, server, notes_dir):
    (notes_dir / "typed.md").write_text("---\ntitle: Typed\ntype:\n  - contact\n  - interview\n---\n\n# Typed\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "typed")
    page.goto(f"{server}/notes/alpha")
    label = page.locator(".notes-action-bar .notes-type-label")
    expect(label).to_have_text("note")  # unset: the default (shown capitalised by CSS)
    assert "alpha.md" not in page.locator(".notes-action-bar").inner_text()
    expect(label).to_have_attribute("title", "alpha.md")
    page.goto(f"{server}/notes/typed")
    expect(page.locator(".notes-type-name")).to_have_text(["contact", "interview"])  # one chip per type
    expect(page.locator(".notes-type-chip i")).to_have_class(["fa-solid fa-user", "fa-solid fa-comments"])  # an icon each
    assert page.errors == []


def test_editing_the_note_type_saves_a_list_and_keeps_other_files_style(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha?mode=edit")
    page.wait_for_selector(".cm-content")
    kind = page.locator("#note-type")
    expect(kind).to_have_value("")
    expect(kind).to_have_attribute("placeholder", "note")
    kind.fill("task, urgent")
    expect(page.locator("#note-type-icon")).to_have_class("fa-solid fa-list-check")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    assert "\ntype: [task, urgent]\n" in (notes_dir / "alpha.md").read_text()
    page.click("#edit-note-btn")
    expect(page.locator(".notes-type-name")).to_have_text(["task", "urgent"])
    expect(page.locator(".notes-type-chip i")).to_have_class(["fa-solid fa-list-check", "fa-solid fa-file-lines"])  # unknown type: plain file icon
    # Clearing it removes the key again.
    page.click("#edit-note-btn")
    page.locator("#note-type").fill("")
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 3)
    assert "type:" not in (notes_dir / "alpha.md").read_text()
    assert page.errors == []


def test_saving_a_note_does_not_rewrite_its_existing_type_formatting(page, server, notes_dir):
    (notes_dir / "flow.md").write_text("---\ntitle: Flow\ntype: [contact, interview]\n---\n\n# Flow\n\ntext\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "flow")
    page.goto(f"{server}/notes/flow?mode=edit")
    page.wait_for_selector(".cm-content")
    expect(page.locator("#note-type")).to_have_value("contact, interview")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" more")
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 3)
    assert "\ntype: [contact, interview]\n" in (notes_dir / "flow.md").read_text()  # untouched: still the flow list
    assert page.errors == []


# --- PlantUML previews ------------------------------------------------------------------------------------------------

import contextlib  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402

from src.application.diagrams.service import DiagramService  # noqa: E402
from tests.application.test_diagram_service import FAKE_SVG, FakeRunner  # noqa: E402

DIAGRAM_NOTE = (
    "---\ntitle: Flows\n---\n\n# Flows\n\nBefore.\n\n"
    "```plantuml\n@startuml\nAlice -> Bob: one\n@enduml\n```\n\n"
    "Between.\n\n"
    "```puml\n@startuml\nAlice -> Carol: two\n@enduml\n```\n"
)


@contextlib.contextmanager
def serve(notes_dir, diagram_service):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir, watch=False, diagram_service=diagram_service), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.should_exit = True
        thread.join(5)


def fake_diagrams(tmp_path, notes_dir, runner=None, available=True):
    java = tmp_path / "fake-java"
    java.write_text("")
    jar = tmp_path / "fake.jar"
    jar.write_text("")
    return DiagramService(str(java) if available else None, jar, notes_dir, runner=runner or FakeRunner())


@pytest.fixture
def diagram_note(notes_dir):
    (notes_dir / "flows.md").write_text(DIAGRAM_NOTE)
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "flows")
    return notes_dir


def test_plantuml_fences_render_as_images(page, diagram_note, tmp_path):
    runner = FakeRunner()
    with serve(diagram_note, fake_diagrams(tmp_path, diagram_note, runner)) as server:
        page.goto(f"{server}/notes/flows")
        images = page.locator("#notes-md .notes-diagram-img")
        expect(images).to_have_count(2)  # both ```plantuml and ```puml fences
        assert images.first.get_attribute("src").startswith("data:image/svg+xml")
        expect(page.locator("#notes-md .notes-diagram-status")).to_have_count(0)
        assert page.locator("#notes-md pre code.language-plantuml").count() == 0  # the code is replaced by the image
        assert len(runner.calls) == 2
        # Reopening the note reuses the rendered images: nothing is rendered again.
        page.goto(f"{server}/notes/alpha")
        page.goto(f"{server}/notes/flows")
        expect(page.locator("#notes-md .notes-diagram-img")).to_have_count(2)
        assert len(runner.calls) == 2  # the server's cache (same source)
        assert page.errors == []


def test_editing_a_diagram_rerenders_only_the_changed_block(page, diagram_note, tmp_path):
    runner = FakeRunner()
    with serve(diagram_note, fake_diagrams(tmp_path, diagram_note, runner)) as server:
        page.goto(f"{server}/notes/flows?mode=edit")
        page.wait_for_selector(".cm-content")
        expect(page.locator("#notes-md .notes-diagram-img")).to_have_count(2)
        assert len(runner.calls) == 2
        page.click(".cm-content")
        page.keyboard.press("Control+Home")
        page.keyboard.type("Typing in the heading must not re-render diagrams. ")
        expect(page.locator("#notes-md")).to_contain_text("Typing in the heading")
        expect(page.locator("#notes-md .notes-diagram-img")).to_have_count(2)  # stayed images while typing: no flicker
        assert len(runner.calls) == 2
        # Change one diagram's source: only that one is rendered again, after a short pause.
        page.keyboard.press("Control+End")
        page.keyboard.press("ArrowUp")
        page.keyboard.press("ArrowUp")
        page.keyboard.press("Home")
        page.keyboard.type("Carol -> Dave: three\n")
        wait_until(lambda: len(runner.calls) == 3)
        assert "Carol -> Dave: three" in runner.calls[2]["source"]
        expect(page.locator("#notes-md .notes-diagram-img")).to_have_count(2)
        assert page.errors == []


def wait_until(predicate, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    raise AssertionError("condition not met in time")


def test_missing_renderer_keeps_the_code_and_says_why(page, diagram_note, tmp_path):
    with serve(diagram_note, fake_diagrams(tmp_path, diagram_note, available=False)) as server:
        page.goto(f"{server}/notes/flows")
        expect(page.locator("#notes-md .notes-diagram-error").first).to_contain_text("PlantUML is not set up")
        expect(page.locator("#notes-md .notes-diagram pre code")).to_have_count(2)  # the source is still readable
        assert page.locator(".notes-diagram-img").count() == 0
        # The note itself still works.
        expect(page.locator("#notes-md h1")).to_have_text("Flows")


def test_a_failed_render_shows_the_error_and_is_not_retried(page, diagram_note, tmp_path):
    runner = FakeRunner(stdout="", stderr="java exploded")
    with serve(diagram_note, fake_diagrams(tmp_path, diagram_note, runner)) as server:
        page.goto(f"{server}/notes/flows")
        expect(page.locator("#notes-md .notes-diagram-error").first).to_contain_text("Could not render this diagram")
        time.sleep(1.0)
        assert len(runner.calls) == 2  # one attempt per diagram, no retry loop
        expect(page.locator("#notes-md .notes-diagram pre code")).to_have_count(2)


needs_java = pytest.mark.skipif(
    not (os.environ.get("PLANTUML_JAVA") and Path(os.environ["PLANTUML_JAVA"]).is_file()
         and Path(os.path.expanduser(os.environ.get("PLANTUML_JAR", "~/.local/share/hive/plantuml/plantuml.jar"))).is_file()),
    reason="needs PLANTUML_JAVA and plantuml.jar")


@needs_java
def test_real_plantuml_draws_a_decodable_image(page, diagram_note):
    real = DiagramService(os.environ["PLANTUML_JAVA"], os.path.expanduser(os.environ.get("PLANTUML_JAR", "~/.local/share/hive/plantuml/plantuml.jar")), diagram_note)
    with serve(diagram_note, real) as server:
        page.goto(f"{server}/notes/flows")
        img = page.locator("#notes-md .notes-diagram-img").first
        expect(img).to_be_visible(timeout=15000)
        assert img.evaluate("e => e.complete && e.naturalWidth > 50 && e.naturalHeight > 50")
        assert page.errors == []


def test_unset_type_shows_the_default_note_icon(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator(".notes-type-chip i")).to_have_class("fa-solid fa-note-sticky")
    expect(page.locator(".notes-type-name")).to_have_text("note")


def test_spotlight_rows_show_an_icon_for_the_notes_type(page, server, notes_dir):
    for slug, title, types in [("t1", "A Task", "[task]"), ("c1", "A Contact", "[contact, interview]"), ("h1", "A Holiday", "holiday")]:
        (notes_dir / f"{slug}.md").write_text(f"---\ntitle: {title}\ntype: {types}\nupdated: 2026-03-0{len(slug)}\n---\n\n# {title}\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "typed notes")
    page.goto(f"{server}/notes/alpha")
    page.keyboard.press("Control+k")
    rows = page.locator("note-spotlight .spotlight-item")
    expect(rows).to_have_count(5)

    def icon(title):
        return rows.filter(has_text=title).locator(".spotlight-item-icon i")

    expect(icon("A Task")).to_have_class("fa-solid fa-list-check")
    expect(icon("A Contact")).to_have_class("fa-solid fa-user")  # the first of its types
    expect(icon("A Holiday")).to_have_class("fa-solid fa-umbrella-beach")  # a scalar `type:` works too
    expect(icon("Alpha")).to_have_class("fa-solid fa-note-sticky")  # no type: the default
    expect(rows.filter(has_text="A Contact").locator(".spotlight-item-icon")).to_have_attribute("title", "contact, interview")
    assert page.errors == []



# --- Pandora's shell: header and sidebar --------------------------------------------------------------------------------

def test_sidebar_has_notes_tasks_and_the_hardcoded_user(page, server):
    page.goto(f"{server}/notes/alpha")
    links = page.locator("app-sidebar .nav-link")
    expect(links).to_have_count(2)
    expect(links.first).to_have_text("Notes")
    expect(links.first).to_have_class("nav-link active")
    expect(links.first).to_have_attribute("aria-current", "page")
    expect(links.nth(1)).to_have_text("Tasks")
    expect(page.locator("app-sidebar .sidebar-profile-name")).to_have_text("Ramesh Thiruchelvam")
    expect(page.locator("app-sidebar .sidebar-profile-avatar")).to_have_text("RT")  # initials of the first two names
    # The user sits at the bottom of the sidebar, below the navigation.
    nav, profile, bar = (page.locator(s).bounding_box() for s in ("app-sidebar .sidebar-nav", "app-sidebar .sidebar-profile", "app-sidebar .app-sidebar"))
    assert profile["y"] > nav["y"] + nav["height"] and profile["y"] + profile["height"] <= bar["y"] + bar["height"] + 1
    assert profile["y"] + profile["height"] > page.viewport_size["height"] - 40
    assert page.errors == []


def test_header_has_the_notes_heading_and_a_breadcrumb_for_the_note(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("app-header")).to_have_attribute("heading", "Notes")
    expect(page.locator("#search-notes-btn")).to_be_visible()
    labels = lambda: page.evaluate("document.querySelector('app-header').breadcrumbs.map((c) => c.label)")  # noqa: E731
    assert labels() == ["Notes", "Alpha"]
    page.goto(f"{server}/notes/new")
    page.wait_for_selector(".cm-content")
    assert labels() == ["Notes", "New note"]
    assert page.errors == []


def test_sidebar_collapse_gives_the_space_back_and_is_remembered(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("#notes-md h1")).to_be_visible()
    assert page.locator(".notes-action-bar").bounding_box()["x"] > 200
    page.click("app-sidebar .desktop-collapse-btn")
    expect(page.locator("app-sidebar")).to_have_class("sidebar-collapsed")
    assert page.locator(".notes-action-bar").bounding_box()["x"] == 0
    page.reload()
    expect(page.locator("app-sidebar")).to_have_class("sidebar-collapsed")  # remembered across page loads
    expect(page.locator("#notes-md h1")).to_be_visible()
    page.click("app-sidebar .sidebar-expand-btn")
    expect(page.locator("app-sidebar")).not_to_have_class("sidebar-collapsed")
    assert page.locator(".notes-action-bar").bounding_box()["x"] > 200
    assert page.errors == []


def test_sidebar_notes_link_opens_the_latest_note_without_reloading(page, server):
    page.goto(f"{server}/notes/beta")
    expect(page.locator("#notes-md")).to_contain_text("Beta body text")
    page.evaluate("window.__stillHere = true")
    page.click("app-sidebar .nav-link")
    page.wait_for_url("**/notes/alpha")  # alpha is the most recently edited
    expect(page.locator("#notes-md h1")).to_have_text("Alpha")
    assert page.evaluate("window.__stillHere === true")  # in-app navigation, not a page load
    assert page.errors == []


def test_sidebar_link_asks_before_dropping_unsaved_edits(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("unsaved words")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.click("app-sidebar .nav-link")
    page.click("[data-action=cancel]")
    assert page.url.endswith("/notes/beta?mode=edit")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.click("app-sidebar .nav-link")
    page.click("[data-action=confirm]")
    page.wait_for_url("**/notes/alpha")
    assert "unsaved words" not in (notes_dir / "beta.md").read_text()
    assert page.errors == []


# -- task board -----------------------------------------------------------------

@pytest.fixture
def task_notes(notes_dir):
    (notes_dir / "write-report.md").write_text("---\ntitle: Write report\ntype: task\ntags: [todo, work]\ncreated: 2026-01-01\nupdated: 2026-03-01\n---\n\n# Write report\n")
    today = date.today().isoformat()
    (notes_dir / "ship-it.md").write_text(f"---\ntitle: Ship it\ntype: task\ntags: [done]\ncreated: 2026-01-01\nupdated: {today}\n---\n\n# Ship it\n")
    (notes_dir / "old-win.md").write_text("---\ntitle: Old win\ntype: task\ntags: [done]\ncreated: 2026-01-01\nupdated: 2020-06-01\n---\n\n# Old win\n")
    (notes_dir / "review.md").write_text("---\ntitle: Review\ntype: [task]\nstatus: IN_PROGRESS\ncreated: 2026-01-01\nupdated: 2026-03-03\n---\n\n# Review\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "tasks")
    return notes_dir


def column(page, value):
    return page.locator(f'.board-column[data-column-value="{value}"]')


def test_tasks_board_groups_task_notes_by_status(page, server, task_notes):
    page.goto(f"{server}/tasks")
    expect(page).to_have_title("Tasks - Hive")
    expect(column(page, "TODO").locator(".board-card-title")).to_have_text(["Write report"])
    expect(column(page, "IN_PROGRESS").locator(".board-card-title")).to_have_text(["Review"])
    expect(column(page, "DONE").locator(".board-card-title")).to_have_text(["Ship it"])
    expect(column(page, "TODO").locator(".board-chip")).to_have_text(["work"])  # `todo` only restates the column
    expect(page.locator("app-sidebar .nav-link.active")).to_have_text("Tasks")
    assert page.errors == []


def test_tasks_board_drag_saves_the_status_as_a_commit(page, server, task_notes):
    page.goto(f"{server}/tasks")
    before = len(git(task_notes, "rev-list", "HEAD").split())
    card = column(page, "TODO").locator(".board-card", has_text="Write report")
    card.drag_to(column(page, "IN_PROGRESS"))
    expect(column(page, "IN_PROGRESS").locator(".board-card", has_text="Write report")).to_have_count(1)
    wait_for_commits(task_notes, before + 1)
    text = (task_notes / "write-report.md").read_text()
    assert "status: IN_PROGRESS" in text and "tags: [todo, work]" in text
    page.reload()
    expect(column(page, "IN_PROGRESS").locator(".board-card", has_text="Write report")).to_have_count(1)
    assert page.errors == []


def pick(drawer, name, label):
    """Choose an option of one of the drawer's comboboxes."""
    combo = drawer.locator(f'app-combobox:has([name="{name}"])')
    combo.locator(".combobox-input").click()
    combo.locator(".combobox-option", has_text=label).click()


def test_tasks_card_opens_a_drawer_and_its_link_opens_the_note(page, server, task_notes):
    page.goto(f"{server}/tasks")
    column(page, "DONE").locator(".board-card", has_text="Ship it").click()
    expect(page.locator("#task-drawer-title")).to_be_visible()
    expect(page.locator('.task-drawer-host [name="title"]')).to_have_value("Ship it")
    page.click("[data-open-note]")
    page.wait_for_url("**/notes/ship-it")
    expect(page.locator("#notes-md h1")).to_have_text("Ship it")
    page.click('app-sidebar .nav-link[href="/tasks"]')  # from the notes page: a full navigation, not the notes router
    page.wait_for_url("**/tasks")
    expect(column(page, "TODO").locator(".board-card")).to_have_count(1)
    assert page.errors == []


def test_tasks_drawer_saves_title_status_priority_and_tags_as_one_commit(page, server, task_notes):
    page.goto(f"{server}/tasks")
    before = len(git(task_notes, "rev-list", "HEAD").split())
    column(page, "TODO").locator(".board-card", has_text="Write report").click()
    drawer = page.locator(".task-drawer-host")
    drawer.locator('[name="title"]').fill("Write the report")
    pick(drawer, "status", "In Progress")
    pick(drawer, "priority", "Must")
    drawer.locator('[name="tags"]').fill("todo, work, q4")
    drawer.locator("[data-save]").click()
    card = column(page, "IN_PROGRESS").locator(".board-card", has_text="Write the report")
    expect(card).to_have_count(1)
    expect(card.locator(".board-chip--must")).to_have_text("Must")
    wait_for_commits(task_notes, before + 1)
    text = (task_notes / "write-the-report.md").read_text()
    assert "status: IN_PROGRESS" in text and "tags: [todo, work, q4, must]" in text
    assert not (task_notes / "write-report.md").exists()
    assert len(git(task_notes, "rev-list", "HEAD").split()) == before + 1
    assert page.errors == []


def test_tasks_show_week_numbers_and_done_has_a_week_filter(page, server, task_notes):
    page.goto(f"{server}/tasks")
    this_week = date.today().isocalendar().week
    key = f"{date.today().isocalendar().year}-W{this_week:02d}"
    expect(column(page, "DONE").locator(".board-card", has_text="Ship it").locator(".board-chip--week")).to_have_text(f"W{this_week}")
    expect(column(page, "TODO").locator(".board-card", has_text="Write report").locator(".board-chip--week")).to_have_text("W9")  # updated 2026-03-01
    # Pandora's pill sits in the Done column header and starts on this week; the address names the week.
    pill = column(page, "DONE").locator(".work-done-filter-btn")
    expect(pill).to_have_text(f"Week {this_week:02d} {date.today().isocalendar().year}")
    page.wait_for_url(f"**/tasks?done={key}")
    expect(column(page, "DONE").locator(".board-card-title")).to_have_text(["Ship it"])
    expect(column(page, "TODO").locator(".board-card")).to_have_count(1)  # open tasks are never filtered
    expect(page.locator("#tasks-week-btn")).to_have_count(0)  # no toggle in the page header any more
    # The list has every week with finished tasks (with counts), newest first, then All weeks.
    pill.click()
    items = column(page, "DONE").locator(".work-done-filter-menu .app-dropdown-item")
    expect(items.last).to_have_attribute("aria-label", "All weeks (2)")
    items.last.click()
    page.wait_for_url("**/tasks?done=all")
    expect(column(page, "DONE").locator(".board-card-title")).to_have_text(["Ship it", "Old win"])
    page.reload()  # the choice is in the address
    expect(column(page, "DONE").locator(".work-done-filter-btn")).to_have_text("All weeks")
    page.goto(f"{server}/tasks?done=2020-W23")  # a shared link to the week of "Old win" (updated 2020-06-01)
    expect(column(page, "DONE").locator(".board-card-title")).to_have_text(["Old win"])
    assert page.errors == []


def test_tasks_page_fills_the_width_and_has_the_same_header_as_notes(page, server, task_notes):
    page.goto(f"{server}/notes/alpha")
    notes_header = page.locator("app-header").bounding_box()
    notes_app = page.locator("notes-app").bounding_box()
    page.goto(f"{server}/tasks")
    expect(column(page, "TODO")).to_be_visible()
    header = page.locator("app-header").bounding_box()
    app = page.locator("tasks-app").bounding_box()
    # Same box as the notes page: edge to edge beside the sidebar, header at the same place and height.
    assert (app["x"], app["width"]) == (notes_app["x"], notes_app["width"])
    assert (header["x"], header["y"], header["width"], header["height"]) == (notes_header["x"], notes_header["y"], notes_header["width"], notes_header["height"])
    # The board spans the page: first column starts at the page padding and the last ends at the right padding.
    cols = page.locator(".board-column")
    first, last = cols.first.bounding_box(), cols.last.bounding_box()
    assert first["x"] - app["x"] <= 32 and (app["x"] + app["width"]) - (last["x"] + last["width"]) <= 32
    expect(page.locator("app-header #search-notes-btn")).to_be_visible()  # the header buttons match the notes page: just Search
    assert page.errors == []

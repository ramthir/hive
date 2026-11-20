"""End-to-end UI flows against a real server and a temp notes repo."""
import socket
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
    assert page.locator("app-header").count() == 0  # no page header
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
    assert bar["x"] == 0 and bar["width"] == page.viewport_size["width"]  # no sidebar offset


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
    assert "tags:\n  - one\n  - two\n  - three\n" in text
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


def test_heading_starts_at_the_top_of_the_page(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("#notes-md h1")).to_be_visible()
    assert page.locator(".notes-editor-workspace").bounding_box()["y"] == 0  # nothing above the note
    assert page.locator("#notes-md h1").bounding_box()["y"] <= 24  # only the pane's own padding


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
    expect(page.locator(".notes-type-name")).to_have_text("contact, interview")  # a list, as stored in the vault
    expect(page.locator("#note-type-icon")).to_have_class("fa-solid fa-user")  # the first type picks the icon
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
    assert "\ntype:\n  - task\n  - urgent\n" in (notes_dir / "alpha.md").read_text()
    page.click("#edit-note-btn")
    expect(page.locator(".notes-type-name")).to_have_text("task, urgent")
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

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


def test_search_box_lists_recent_notes_then_filters(page, server):
    page.goto(f"{server}/notes/alpha")
    page.click("#notes-note-search-input")
    expect(page.locator("#notes-note-search .autocomplete-option, #notes-note-search [role=option]").first).to_be_visible()
    options = page.locator("#notes-note-search [role=option]")
    expect(options).to_have_count(2)
    expect(options.first).to_contain_text("Alpha")  # most recently edited first
    page.fill("#notes-note-search-input", "beta body")
    expect(options).to_have_count(1)
    options.first.click()
    page.wait_for_url("**/notes/beta")
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
    expect(page.locator(".notes-type-label")).to_contain_text("renamed-idea.md")

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

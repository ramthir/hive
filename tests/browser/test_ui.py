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


def git(root, *a):
    return subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True, check=True).stdout


@pytest.fixture
def notes_dir(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        git(tmp_path, *a)
    (tmp_path / "alpha.md").write_text("---\ntitle: Alpha\ntags:\n  - one\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Alpha\n\nSee [[beta]] and [[Nope]].\n\n```python\nprint(1)\n```\n")
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


def test_list_search_and_tags(page, server):
    page.goto(server)
    page.wait_for_url("**/notes")
    expect(page.locator(".note-card")).to_have_count(2)
    page.fill("#notes-search-input", "beta")
    expect(page.locator(".note-card")).to_have_count(1)
    expect(page.locator(".note-card-title")).to_contain_text("Beta")
    page.fill("#notes-search-input", "")
    page.click('.notes-tag[data-tag="one"]')
    expect(page.locator(".note-card")).to_have_count(1)
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
    expect(page.locator("#notes-backlinks")).to_contain_text("Alpha")
    assert page.errors == []


def test_edit_save_commits_to_git(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type("\n\nAdded line")
    expect(page.locator("#notes-md")).to_contain_text("Added line")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    expect(page.locator("#save-note-btn")).to_be_disabled()
    assert "Added line" in (notes_dir / "beta.md").read_text()
    assert git(notes_dir, "log", "-1", "--format=%s").strip() == "doc: update Beta Note"
    assert page.errors == []


def test_new_note_rename_history_restore_delete(page, server, notes_dir):
    page.goto(f"{server}/notes/new")
    page.fill("#note-title", "Fresh Idea")
    page.fill("#note-tags", "x, y")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("# Fresh Idea\n\nfirst")
    page.keyboard.press("Control+s")
    page.wait_for_url("**/notes/fresh-idea?mode=edit")
    assert (notes_dir / "fresh-idea.md").exists()

    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" second")
    page.keyboard.press("Control+s")
    expect(page.locator("#save-note-btn")).to_be_disabled()

    page.click("#note-versions-btn")
    rows = page.locator(".hive-version-row")
    expect(rows).to_have_count(2)
    rows.nth(1).click()  # the creation commit
    expect(page.locator(".hive-diff .add").first).to_be_visible()
    page.click("#version-restore")
    page.click(".confirm-dialog .primary, .confirm-dialog [data-action=confirm], [data-action=confirm]")
    expect(page.locator("#notes-md")).not_to_contain_text("second")
    assert "second" not in (notes_dir / "fresh-idea.md").read_text()
    assert git(notes_dir, "log", "-1", "--format=%s").startswith("doc: restore Fresh Idea")

    page.click("#delete-note-btn")
    page.click("[data-action=confirm]")
    page.wait_for_url("**/notes")
    assert not (notes_dir / "fresh-idea.md").exists()
    assert git(notes_dir, "log", "-1", "--format=%s").strip() == "doc: delete Fresh Idea"
    assert page.errors == []

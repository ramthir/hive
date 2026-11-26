"""End-to-end UI flows against a real server and a temp notes repo."""
import re
import socket
from datetime import date
import subprocess
import threading
import time
from types import SimpleNamespace

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


class _UsageCollector:
    """A ccusage that answers at once with a small, fixed report (the tests never run the real one)."""

    def collect(self, now):
        from tests.agent_reports import envelope
        return envelope(now, since=now.replace(day=1).strftime("%Y-%m-%d"))


@pytest.fixture
def agents_server(notes_dir, tmp_path_factory):
    from src.application.agents.quota import AgentQuota
    from src.application.agents.usage import AgentUsage
    from src.domain.agents.quota import QuotaError, parse_snapshot
    from src.infrastructure.agents.usage_files import ReportStore
    from tests.agent_reports import quota_snapshot
    folder = tmp_path_factory.mktemp("agents")

    class Quota:
        def collect(self, now):
            return quota_snapshot(now, ok=("claude", "codex"), five=40.0, week=29.0)
    usage = AgentUsage(ReportStore(folder / "usage.json"), _UsageCollector())
    quota = AgentQuota(ReportStore(folder / "quota.json", parse_snapshot, (QuotaError,), "quota snapshot"), Quota(), background=False)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir, agent_usage=usage, agent_quota=quota), port=port, log_level="warning"))
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
    expect(page.locator("app-header")).to_have_attribute("heading", "Alpha")
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


def test_spotlight_uses_more_width_and_fits_the_window(page, server):
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(f"{server}/notes/alpha")
    page.keyboard.press("Control+k")
    panel = page.locator("note-spotlight .spotlight-panel")
    expect(panel).to_have_css("width", "832px")

    page.set_viewport_size({"width": 800, "height": 800})
    bounds = panel.bounding_box()
    assert bounds["x"] >= 16
    assert bounds["x"] + bounds["width"] <= 784


def test_spotlight_shows_up_to_ten_recent_notes_and_matches(page, server, notes_dir):
    page.set_viewport_size({"width": 1280, "height": 720})
    for number in range(12):
        title = f"Spotlight Match {number}"
        (notes_dir / f"spotlight-match-{number}.md").write_text(f"---\ntitle: {title}\n---\n\n# {title}\n")
    page.request.post(f"{server}/api/reindex")
    page.goto(f"{server}/notes/alpha")
    page.keyboard.press("Control+k")
    rows = page.locator("note-spotlight .spotlight-item")
    expect(rows).to_have_count(10)

    with page.expect_response(lambda response: "/api/notes?q=" in response.url) as search:
        page.fill("note-spotlight .spotlight-input", "Spotlight Match")
    assert len(search.value.json()) == 10
    expect(rows.filter(has_text="Spotlight Match")).to_have_count(10)

    results = page.locator("note-spotlight .spotlight-results")
    assert results.evaluate("(list) => list.scrollHeight === list.clientHeight")
    page.set_viewport_size({"width": 1280, "height": 380})
    assert results.evaluate("(list) => list.scrollHeight > list.clientHeight")
    page.keyboard.press("ArrowUp")
    expect(rows.last).to_have_attribute("aria-selected", "true")
    assert results.evaluate("(list) => list.scrollTop > 0")


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
    expect(page.locator("app-header")).to_have_attribute("heading", "Alpha")
    good = page.locator('.notes-wikilink[data-target="beta"]')
    expect(good).to_have_text("Beta Note")  # auto-label replaced by the target's title
    expect(good).to_have_attribute("href", "/notes/beta")
    expect(good).to_have_css("text-decoration-line", "underline")
    expect(good).to_have_css("border-top-width", "0px")
    expect(good).to_have_css("padding-inline-start", "0px")
    missing = page.locator('.notes-wikilink[data-target="Nope"]')
    expect(missing).to_have_class("notes-wikilink unresolved")
    expect(missing).to_have_css("text-decoration-style", "dashed")
    expect(page.locator(".notes-copy-code-btn")).to_have_count(1)
    expect(page.locator("#notes-backlinks")).to_contain_text("Broken links")
    good.click()
    page.wait_for_url("**/notes/beta")
    expect(page.locator("app-header")).to_have_attribute("heading", "Beta Note")  # beta has no heading on disk: its title is shown as one
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


def test_opening_history_saves_unsaved_edits_so_a_restore_keeps_them(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type("\n\nUnsaved line")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.click("#note-versions-btn")  # saves first, then opens
    expect(page.locator(".hive-version-row").first).to_be_visible()
    assert "Unsaved line" in (notes_dir / "beta.md").read_text()
    rows = page.locator(".hive-version-row")
    expect(rows.first.locator(".msg")).to_contain_text("Edited text")
    rows.last.click()  # the oldest version
    page.click("#version-restore")
    page.click("[data-action=confirm]")
    expect(page.locator(".hive-version-row")).to_have_count(0)
    page.wait_for_function("!document.querySelector('.cm-content')?.textContent.includes('Unsaved line')")
    # The edit is not lost: it is the version just before the restore.
    assert "Unsaved line" in git(notes_dir, "show", "HEAD~1:beta.md")
    assert page.errors == []


def test_history_survives_a_commit_whose_sha_changed_while_it_was_open(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    page.click("#note-versions-btn")
    expect(page.locator(".hive-version-row").first).to_be_visible()
    old = page.locator(".hive-version-row").first.get_attribute("data-sha")
    git(notes_dir, "commit", "--amend", "-m", "doc: reworded by someone else")  # what the Codex rewording does
    assert not (git(notes_dir, "rev-parse", "HEAD").strip() == old)
    page.locator(".hive-version-row").first.click()
    expect(page.locator(".hive-diff")).to_be_visible()
    expect(page.locator(".note-version-message.error")).to_have_count(0)
    expect(page.locator(".hive-vd-summary .meta code")).to_have_text(git(notes_dir, "rev-parse", "--short=7", "HEAD").strip())
    assert all("404" in error for error in page.errors)  # only the browser's note of the one stale request


def test_a_version_opens_from_what_hovering_fetched_and_a_deleted_one_cannot_be_opened(page, server):
    api = f"{server}/api/notes"
    page.request.post(api, data={"content": "# Gone\n\none\n"})
    page.request.delete(f"{api}/gone")
    page.request.post(api, data={"content": "# Gone\n\ntwo\n"})
    diffs = []
    page.on("request", lambda request: diffs.append(request.url) if "/diff" in request.url else None)
    page.goto(f"{server}/notes/gone")
    page.click("#note-versions-btn")
    rows = page.locator(".hive-version-row")
    expect(rows).to_have_count(3)  # created again, deleted, created
    expect(rows.nth(1)).to_be_disabled()
    expect(rows.nth(1)).to_contain_text("Deleted the note")
    rows.first.hover()
    page.wait_for_timeout(500)  # the row is fetched while the pointer rests on it
    assert len(diffs) >= 1
    fetched = len(diffs)
    rows.first.click()
    expect(page.locator(".hive-diff")).to_be_visible()
    assert len([u for u in diffs[fetched:] if "against=previous" in u and rows.first.get_attribute("data-sha") in u]) == 0
    page.click("#version-older")  # steps over the deleted version to the first one
    expect(page.locator("#version-position")).to_have_text("3 of 3")
    expect(page.locator("#version-older")).to_be_disabled()


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

    # History follows the file; restoring the first version brings back the old title and file name.
    page.click("#note-versions-btn")
    rows = page.locator(".hive-version-row")
    expect(rows).to_have_count(3)  # added, renamed, updated
    expect(page.locator(".hive-version-day").first).to_have_text("Today")
    # The rail joins the first circle to the last: it does not stick out above or below them.
    rail = page.evaluate("""() => {
      const list = document.querySelector('#version-list');
      const icons = [...list.querySelectorAll('.hive-version-icon')].map((i) => i.getBoundingClientRect());
      const top = list.getBoundingClientRect().top - list.scrollTop;
      const style = getComputedStyle(list);
      return { top: parseFloat(style.getPropertyValue('--rail-top')), height: parseFloat(style.getPropertyValue('--rail-height')),
               first: icons[0].top + icons[0].height / 2 - top, last: icons.at(-1).top + icons.at(-1).height / 2 - top };
    }""")
    assert abs(rail["top"] - rail["first"]) < 1.5 and abs(rail["top"] + rail["height"] - rail["last"]) < 1.5
    expect(page.locator(".hive-version-stat").first).to_be_visible()
    expect(rows.first).to_contain_text("Edited text")
    expect(rows.last).to_contain_text("Created the note")
    expect(page.locator("app-tab-bar [role=tab]")).to_have_count(5)
    expect(page.locator("[data-tab=all]")).to_have_attribute("aria-selected", "true")
    page.click("[data-tab=restores]")  # asks the server for that kind of version
    expect(page.locator("[data-tab=restores]")).to_have_attribute("aria-selected", "true")
    expect(page.locator(".hive-version-row:not([hidden])")).to_have_count(0)
    expect(page.locator("#version-list")).to_contain_text("No changes of this kind")
    page.keyboard.press("Home")  # arrow keys and Home/End move between the tabs
    page.keyboard.press("ArrowRight")
    expect(page.locator("[data-tab=text]")).to_have_attribute("aria-selected", "true")
    expect(page.locator(".hive-version-row:not([hidden])")).to_have_count(1)
    page.click("[data-tab=all]")
    expect(page.locator(".hive-version-row:not([hidden])")).to_have_count(3)
    rows.nth(2).click()
    expect(page.locator(".hive-diff")).to_be_visible()
    page.keyboard.press("ArrowRight")  # newer version
    expect(page.locator(".hive-vd-summary .meta code")).not_to_have_text((rows.nth(2).get_attribute("data-sha") or "")[:7])
    page.keyboard.press("Escape")  # back to the list, dialog stays open
    expect(rows.first).to_be_visible()
    rows.nth(2).click()
    expect(page.locator(".hive-diff")).to_be_visible()
    expect(page.locator(".hive-diff-row.add").first).to_be_visible()
    page.click(".hive-vd-compare [data-tab=current]")  # what restoring would change
    expect(page.locator(".hive-vd-compare [data-tab=current]")).to_have_attribute("aria-selected", "true")
    expect(page.locator(".hive-diff-row.del").first).to_be_visible()
    expect(page.locator("#version-position")).to_have_text("3 of 3")
    expect(page.locator("#version-older")).to_be_disabled()
    page.click("#version-newer")  # the buttons step like the arrow keys
    expect(page.locator("#version-position")).to_have_text("2 of 3")
    page.click("#version-older")
    expect(page.locator("#version-position")).to_have_text("3 of 3")
    page.click("#version-restore")
    expect(page.locator(".confirm-dialog-details")).to_contain_text("renamed back")
    page.click("[data-action=confirm]")
    page.wait_for_url("**/notes/fresh-idea**")
    assert (notes_dir / "fresh-idea.md").exists() and not (notes_dir / "renamed-idea.md").exists()
    expect(page.locator("app-header")).to_have_attribute("heading", "Fresh Idea")

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
    expect(tags.locator(".notes-tag-chip")).to_have_text(["one"])  # chips in read mode; the editor makes them editable
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    field = page.locator("#note-tags")  # now chips with a type-to-add field
    expect(field.locator(".combobox-chip-label")).to_have_text(["one"])
    field.locator(".combobox-input").click()
    page.keyboard.type("two")
    page.keyboard.press("Enter")  # Enter adds what was typed
    page.keyboard.type("three,")  # so does a comma
    page.keyboard.type("four")
    page.click(".cm-content")  # leaving the field adds the pending text too
    expect(field.locator(".combobox-chip-label")).to_have_text(["one", "two", "three", "four"])
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    text = (notes_dir / "alpha.md").read_text()
    assert "tags: [one, two, three, four]\n" in text  # changed, so written inline
    field.locator('.combobox-chip-remove[data-value="four"]').click()
    expect(field.locator(".combobox-chip-label")).to_have_text(["one", "two", "three"])
    expect(page.locator("#save-note-btn")).to_be_enabled()  # the removal is an unsaved change
    page.click("#edit-note-btn")  # close the editor: it asks first
    expect(page.locator("[data-action=confirm]")).to_be_visible()
    page.click("[data-action=confirm]")  # Save and close
    page.wait_for_url("**/notes/alpha")  # no ?mode=edit: the editor is closed
    expect(page.locator("#note-tags .notes-tag-chip")).to_have_text(["one", "two", "three"])  # tags stay visible
    wait_for_commits(notes_dir, 3)
    assert "tags: [one, two, three]\n" in (notes_dir / "alpha.md").read_text()
    assert page.errors == []


def test_tag_suggestions_match_existing_tags_ignoring_case_and_offer_to_create(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha?mode=edit")
    page.wait_for_selector(".cm-content")
    field = page.locator("#note-tags")
    field.locator(".combobox-input").click()
    page.keyboard.type("TW")
    expect(field.locator(".combobox-option")).to_have_text(["two1", 'Create "TW"'])  # beta's tag with its count, from /api/tags
    page.keyboard.type("O")  # "TWO" is "two" ignoring case, so nothing new is offered
    expect(field.locator(".combobox-option")).to_have_text(["two1"])
    page.keyboard.press("Enter")  # typed text that matches an existing tag ignoring case uses that tag
    expect(field.locator(".combobox-chip-label")).to_have_text(["one", "two"])
    page.keyboard.type("brand")
    expect(field.locator(".combobox-option")).to_have_text(['Create "brand"'])
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
    expect(page.locator("#notes-md p, #notes-md ul, #notes-md li").first).to_be_visible()
    header = page.locator("app-header").bounding_box()
    workspace = page.locator(".notes-editor-workspace").bounding_box()
    assert abs(workspace["y"] - (header["y"] + header["height"])) < 2  # the note fills the space under the header
    assert page.locator("#notes-md").bounding_box()["y"] - workspace["y"] <= 40  # only the pane's own padding between them


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


def test_editing_the_note_type_is_a_combobox_that_saves_and_clears_the_type(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha?mode=edit")
    page.wait_for_selector(".cm-content")
    kind = page.locator("#note-type")
    expect(kind.locator(".combobox-input")).to_have_value("")
    expect(kind.locator(".combobox-input")).to_have_attribute("placeholder", "Note")
    kind.locator(".combobox-input").click()
    kind.locator(".combobox-option", has_text="Task").first.click()
    expect(kind.locator(".combobox-chip")).to_have_text(["Task"])  # a chip in title case, saved as `task`
    expect(kind.locator(".combobox-chip > i")).to_have_count(1)  # with the type's icon
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    assert "\ntype: task\n" in (notes_dir / "alpha.md").read_text()
    expect(page.locator("#note-properties-btn")).to_have_count(1)  # task: the type's properties appear without a reload
    page.click("#edit-note-btn")
    page.wait_for_url("**/tasks/alpha")  # a task is read on its own page
    # Clearing it removes the key again.
    page.click("#edit-note-btn")
    page.locator("#note-type .combobox-clear").click()
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
    expect(page.locator("#note-type .combobox-chip-label")).to_have_text(["Contact", "Interview"])  # several types are chips too
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
        expect(page.locator("app-header")).to_have_attribute("heading", "Flows")


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

def test_library_is_its_own_app_with_only_its_three_links(page, server):
    page.goto(f"{server}/iptv?type=series")
    expect(page.locator("app-sidebar .logo-text")).to_have_text("Media Library")
    links = page.locator("app-sidebar .nav-link")
    expect(links).to_have_text(["Movies", "Series", "Television"])
    expect(links.nth(1)).to_have_class("nav-link active")
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("app-sidebar .logo-text")).to_have_text("Note Hive")
    expect(page.locator("app-sidebar .nav-link", has_text="Media Library")).to_have_count(0)


def test_sidebar_has_dashboard_notes_tasks_time_chat_and_the_hardcoded_user(page, server):
    page.goto(f"{server}/notes/alpha")
    links = page.locator("app-sidebar .nav-link")
    expect(links).to_have_count(5)
    expect(links.first).to_have_text("Dashboard")
    notes = links.nth(1)
    expect(notes).to_have_text("Notes")
    expect(notes).to_have_class("nav-link active")
    expect(notes).to_have_attribute("aria-current", "page")
    expect(links.nth(2)).to_have_text("Tasks")  # right under Notes
    expect(links.nth(3)).to_have_text("Time Entries")
    expect(links.nth(4)).to_have_text("Chat")
    expect(page.locator("app-sidebar .sidebar-profile-name")).to_have_text("Ramesh Thiruchelvam")
    expect(page.locator("app-sidebar .sidebar-profile-avatar")).to_have_text("RT")  # initials of the first two names
    # The user sits at the bottom of the sidebar, below the navigation.
    nav, profile, bar = (page.locator(s).bounding_box() for s in ("app-sidebar .sidebar-nav", "app-sidebar .sidebar-profile", "app-sidebar .app-sidebar"))
    assert profile["y"] >= nav["y"] + nav["height"] - 1 and profile["y"] + profile["height"] <= bar["y"] + bar["height"] + 1
    assert profile["y"] + profile["height"] > page.viewport_size["height"] - 40
    assert page.errors == []


def test_header_shows_the_note_title_without_a_breadcrumb(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("app-header")).to_have_attribute("heading", "Alpha")
    expect(page.locator("#search-notes-btn")).to_be_visible()
    assert page.evaluate("document.querySelector('app-header').breadcrumbs.length") == 0
    page.goto(f"{server}/notes/new")
    page.wait_for_selector(".cm-content")
    expect(page.locator("app-header")).to_have_attribute("heading", "New note")
    assert page.errors == []


def test_sidebar_collapse_gives_the_space_back_and_is_remembered(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("#notes-md p, #notes-md ul, #notes-md li").first).to_be_visible()
    assert page.locator(".notes-action-bar").bounding_box()["x"] > 200
    page.click("app-sidebar .desktop-collapse-btn")
    expect(page.locator("app-sidebar")).to_have_class("sidebar-collapsed")
    assert page.locator(".notes-action-bar").bounding_box()["x"] == 0
    page.reload()
    expect(page.locator("app-sidebar")).to_have_class("sidebar-collapsed")  # remembered across page loads
    expect(page.locator("#notes-md p, #notes-md ul, #notes-md li").first).to_be_visible()
    page.click("app-sidebar .sidebar-expand-btn")
    expect(page.locator("app-sidebar")).not_to_have_class("sidebar-collapsed")
    assert page.locator(".notes-action-bar").bounding_box()["x"] > 200
    assert page.errors == []


def test_sidebar_notes_link_opens_the_latest_note_without_reloading(page, server):
    page.goto(f"{server}/notes/beta")
    expect(page.locator("#notes-md")).to_contain_text("Beta body text")
    page.evaluate("window.__stillHere = true")
    page.click("app-sidebar .nav-link[href=\"/notes\"]")
    page.wait_for_url("**/notes/alpha")  # alpha is the most recently edited
    expect(page.locator("app-header")).to_have_attribute("heading", "Alpha")
    assert page.evaluate("window.__stillHere === true")  # in-app navigation, not a page load
    assert page.errors == []


def test_sidebar_link_asks_before_dropping_unsaved_edits(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("unsaved words")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.click("app-sidebar .nav-link[href=\"/notes\"]")
    page.click("[data-action=cancel]")
    assert page.url.endswith("/notes/beta?mode=edit")
    expect(page.locator("#save-note-btn")).to_be_enabled()
    page.click("app-sidebar .nav-link[href=\"/notes\"]")
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
    expect(column(page, "TODO").locator(".board-chip")).to_have_text(["W9", "work"])  # the week of `updated`; `todo` only restates the column
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


def test_tasks_card_opens_the_task_properties_drawer(page, server, task_notes):
    page.goto(f"{server}/tasks")
    column(page, "DONE").locator(".board-card", has_text="Ship it").click()
    drawer = page.locator(".notes-properties-drawer")
    expect(drawer.locator(".modal-title")).to_have_text("Task Properties")
    expect(drawer.locator('[data-key="status"] .combobox-input')).to_have_value("Done")
    drawer.locator('[data-action="cancel"]').click()
    expect(page.locator(".notes-properties-drawer")).to_have_count(0)
    assert page.errors == []


def test_tasks_drawer_saves_status_and_priority_in_one_commit(page, server, task_notes):
    page.goto(f"{server}/tasks")
    before = len(git(task_notes, "rev-list", "HEAD").split())
    column(page, "TODO").locator(".board-card", has_text="Write report").click()
    drawer = page.locator(".notes-properties-drawer")
    for key, label in (("status", "In Progress"), ("priority", "Must")):
        combo = drawer.locator(f'app-combobox[data-key="{key}"]')
        combo.locator(".combobox-input").click()
        combo.locator(".combobox-option", has_text=label).click()
    drawer.locator('[data-action="save"]').click()
    card = column(page, "IN_PROGRESS").locator(".board-card", has_text="Write report")
    expect(card).to_have_count(1)
    expect(card.locator(".board-chip--must")).to_have_text("Must")
    wait_for_commits(task_notes, before + 1)
    text = (task_notes / "write-report.md").read_text()
    assert "status: IN_PROGRESS" in text and "priority: must" in text
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


# -- note properties drawer -----------------------------------------------------

def pick_field(drawer, key, label):
    combo = drawer.locator(f'app-combobox[data-key="{key}"]')
    combo.locator(".combobox-input").click()
    combo.locator(".combobox-option", has_text=label).click()


@pytest.fixture
def property_notes(notes_dir):
    (notes_dir / "acme.md").write_text("---\ntitle: Acme\ntype: project\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Acme\n")
    (notes_dir / "bo.md").write_text("---\ntitle: Bo\ntype: contact\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Bo\n")
    (notes_dir / "cy.md").write_text("---\ntitle: Cy\ntype: contact\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Cy\n")
    (notes_dir / "fix-it.md").write_text("---\ntitle: Fix it\ntype: task\ntags: [todo]\ncreated: 2026-01-01\nupdated: 2026-03-03\n---\n\n# Fix it\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "properties")
    return notes_dir


def test_properties_drawer_saves_a_tasks_fields_as_one_commit(page, server, property_notes):
    page.goto(f"{server}/notes/fix-it")
    page.wait_for_url("**/tasks/fix-it")
    before = len(git(property_notes, "rev-list", "HEAD").split())
    page.click("#note-properties-btn")
    drawer = page.locator(".notes-properties-drawer")
    expect(drawer.locator(".modal-title")).to_have_text("Task Properties")
    expect(drawer.locator("[data-field]")).to_have_count(8)  # project, specification, ticket, status, priority, assignee, week, tags
    pick_field(drawer, "project", "Acme")
    pick_field(drawer, "assignee", "Bo")
    pick_field(drawer, "status", "In Progress")
    pick_field(drawer, "priority", "Must")
    drawer.locator('[data-action="save"]').click()
    expect(page.locator(".notes-properties-drawer")).to_have_count(0)
    wait_for_commits(property_notes, before + 1)
    text = (property_notes / "fix-it.md").read_text()
    assert "project: Acme" in text and "assignee: Bo" in text and "status: IN_PROGRESS" in text
    assert "priority: must" in text and "tags: [todo]" in text
    assert len(git(property_notes, "rev-list", "HEAD").split()) == before + 1
    expect(page.locator("app-header .task-status--in-progress")).to_have_text("In Progress")  # the header chips follow the drawer
    expect(page.locator("app-header .task-priority--must")).to_have_text("Must")
    page.click("#note-properties-btn")  # reopened: shows what was saved
    expect(page.locator('.notes-properties-drawer [data-key="project"] .combobox-input')).to_have_value("Acme")
    assert page.errors == []


def test_properties_drawer_shows_acting_for_only_while_shadowed(page, server, property_notes):
    page.goto(f"{server}/notes/bo")
    page.click("#note-properties-btn")
    drawer = page.locator(".notes-properties-drawer")
    acting = drawer.locator('[data-field="acting_for"]')
    expect(acting).to_be_hidden()
    pick_field(drawer, "billing", "Shadowed")
    expect(acting).to_be_visible()
    drawer.locator('[data-action="save"]').click()
    expect(drawer.locator(".crud-drawer-error")).to_have_text("Acting for is required.")
    pick_field(drawer, "acting_for", "Cy")  # another contact: a note is not offered as its own choice
    drawer.locator('[data-action="save"]').click()
    expect(page.locator(".notes-properties-drawer")).to_have_count(0)
    wait_until(lambda: "billing: Shadowed" in (property_notes / "bo.md").read_text())
    assert "acting_for: Cy" in (property_notes / "bo.md").read_text()


def test_properties_drawer_keeps_unsaved_text_by_saving_it_first_and_has_a_shortcut(page, server, property_notes):
    page.goto(f"{server}/notes/fix-it?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("words typed before opening")
    page.keyboard.press("Control+Shift+P")
    expect(page.locator(".notes-properties-drawer .modal-title")).to_have_text("Task Properties")
    assert "words typed before opening" in (property_notes / "fix-it.md").read_text()


def test_notes_without_a_form_have_no_properties_button(page, server):
    page.goto(f"{server}/notes/beta")
    expect(page.locator("#edit-note-btn")).to_be_visible()
    expect(page.locator("#note-properties-btn")).to_have_count(0)


def test_the_updated_stamp_is_hidden_while_editing(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator(".stat-updated")).to_have_count(1)
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    expect(page.locator(".stat-updated")).to_have_count(0)
    page.click("#edit-note-btn")
    expect(page.locator(".stat-updated")).to_have_count(1)
    assert page.errors == []


def test_sidebar_title_is_note_hive(page, server):
    page.goto(f"{server}/notes/alpha")
    expect(page.locator("app-sidebar .logo-text")).to_have_text("Note Hive")
    assert page.errors == []


def test_time_entries_hint_move_and_orphan_rows(page, server, notes_dir):
    today = date.today().isoformat()
    for slug, title, kind, days in [("fix-login", "Fix login", "task", f"{{{today}: 60}}"),
                                    ("write-docs", "Write docs", "task", None),
                                    ("old-idea", "Old idea", "idea", f"{{{today}: 15}}")]:
        time_line = f"time: {days}\n" if days else ""
        (notes_dir / f"{slug}.md").write_text(f"---\ntitle: {title}\ntype: {kind}\n{time_line}---\n\n# {title}\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "time seed")
    page.request.post(f"{server}/api/reindex")
    commits = len(git(notes_dir, "rev-list", "HEAD").split())

    page.goto(f"{server}/time-entries")
    rows = page.locator("app-table tbody tr")
    expect(rows).to_have_count(2)
    expect(rows.filter(has_text="Old idea").locator(".fa-triangle-exclamation")).to_have_count(1)

    # choosing a note whose day already holds time says that saving adds to it
    page.get_by_role("button", name="Add time").click()
    drawer = page.locator(".time-drawer-host")
    drawer.locator('[name="slug"] .combobox-input').click()
    drawer.locator(".combobox-option").filter(has_text="Fix login").click()
    expect(drawer.locator(".log-time-hint")).to_contain_text("1h already logged")
    drawer.locator('[data-dialog-close]').first.click()
    page.click("[data-action=confirm]")  # Discard the unsaved choice

    # moving a row to another note is a single commit
    rows.filter(has_text="Fix login").click()
    drawer.locator('[name="slug"] .combobox-input').click()
    drawer.locator(".combobox-option").filter(has_text="Write docs").click()
    drawer.locator("[data-save]").click()
    expect(rows.filter(has_text="Write docs")).to_have_count(1)
    expect(rows.filter(has_text="Fix login")).to_have_count(0)
    assert len(git(notes_dir, "rev-list", "HEAD").split()) == commits + 1
    assert page.errors == []


def test_table_note_filters_sorts_links_and_saves_rows(page, server, notes_dir):
    (notes_dir / "ann-lee.md").write_text("---\ntitle: Ann Lee\ntype: contact\n---\n\n# Ann Lee\n")
    (notes_dir / "bo-kim.md").write_text("---\ntitle: Bo Kim\ntype: contact\n---\n\n# Bo Kim\n")
    (notes_dir / "inventory.md").write_text(
        "---\ntitle: Inventory\ntype: table\nupdated: 2026-03-03\n---\n\n# Inventory\n\n"
        "| Employee | Make |\n| --- | --- |\n| [[Ann Lee]] | Lenovo |\n| [[Bo Kim]] | HP |\n\n"
        '```json table-config\n{"stats": [{"label": "Laptops", "op": "count"}, {"label": "HP", "op": "count_where", "column": "Make", "equals": "HP"}]}\n```\n')
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "table")
    commits = len(git(notes_dir, "rev-list", "HEAD").split())

    page.goto(f"{server}/notes/inventory")
    page.wait_for_url("**/tables/inventory")  # a table note is read on its own page
    rows = page.locator("app-table tbody tr")
    expect(rows).to_have_count(2)
    expect(page.locator("app-header")).to_have_attribute("heading", "Inventory")  # the title is the header's
    expect(page.locator("h1")).to_have_count(1)  # no second title in the content
    expect(page.locator("#search-notes-btn")).to_have_count(0)  # one search: the row filter
    cards = page.locator("#notes-table-stats-grid stat-card")  # the stat cards of the table-config block
    expect(cards).to_have_count(2)
    expect(cards.nth(0)).to_contain_text("Laptops")
    expect(cards.nth(0)).to_contain_text("2")
    expect(cards.nth(1)).to_contain_text("1")
    expect(page.locator(".notes-table-filter")).to_have_count(1)
    expect(rows.nth(0).locator("a.notes-wikilink")).to_have_attribute("href", "/notes/ann-lee")

    expect(page.locator(".header-search--filter .header-search-key")).to_have_text("/")
    page.keyboard.press("/")  # the hint's key focuses the filter
    expect(page.locator(".notes-table-filter")).to_be_focused()
    page.fill(".notes-table-filter", "hp")
    expect(rows).to_have_count(1)
    page.fill(".notes-table-filter", "")
    header = page.locator("app-table th", has_text="Make")
    header.click()
    expect(rows.nth(0)).to_contain_text("Lenovo")  # first click sorts descending
    header.click()
    expect(rows.nth(0)).to_contain_text("HP")

    page.click("#add-table-row-btn")
    page.locator("[name=col_0] .combobox-input").click()
    page.get_by_text("Ann Lee", exact=True).last.click()
    page.fill("[name=col_1]", "Apple")
    page.click("[data-save]")
    wait_for_commits(notes_dir, commits + 1)
    text = (notes_dir / "inventory.md").read_text()
    assert "| [[Ann Lee]] | Apple |" in text
    assert "type: table" in text
    expect(rows).to_have_count(3)

    page.locator("app-table tbody tr", has_text="Lenovo").click()
    page.fill("[name=col_1]", "Dell")
    page.click("[data-save]")
    wait_for_commits(notes_dir, commits + 2)
    assert "| [[Ann Lee]] | Dell |" in (notes_dir / "inventory.md").read_text()

    page.click("#edit-note-btn")  # the pencil edits the markdown on the note page
    page.wait_for_url("**/notes/inventory?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click("#edit-note-btn")  # closing the editor goes back to the table
    page.wait_for_url("**/tables/inventory")
    assert page.errors == []


def test_table_page_fills_the_width_beside_the_sidebar(page, server, notes_dir):
    (notes_dir / "wide.md").write_text("---\ntitle: Wide\ntype: table\n---\n\n# Wide\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "wide")
    page.goto(f"{server}/tables/wide")
    expect(page.locator("app-table tbody tr")).to_have_count(1)
    box = page.locator(".notes-table-card").bounding_box()
    sidebar = page.locator("app-sidebar").bounding_box()
    # the card runs from the sidebar to the window's right edge, less the page padding on each side
    assert box["x"] + box["width"] >= 1400 - 40
    assert box["x"] - (sidebar["x"] + sidebar["width"]) <= 40


def test_search_icons_are_coloured_by_note_type(page, server, notes_dir):
    (notes_dir / "job.md").write_text("---\ntitle: Job\ntype: task\nupdated: 2026-04-04\n---\n\n# Job\n")
    (notes_dir / "mystery.md").write_text("---\ntitle: Mystery\ntype: zzz\nupdated: 2026-04-03\n---\n\n# Mystery\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "types")
    page.goto(f"{server}/notes/alpha")
    page.keyboard.press("Control+k")
    icon = lambda title: page.locator("note-spotlight .spotlight-item", has_text=title).locator(".spotlight-item-icon")
    expect(icon("Job")).to_have_attribute("style", "color: var(--color-orange)")
    expect(icon("Alpha")).to_have_attribute("style", "color: var(--color-yellow)")  # no type: the default, note
    expect(icon("Mystery")).to_have_attribute("style", "")  # an unknown type keeps the muted default
    assert page.errors == []


def test_search_shows_a_contacts_role(page, server, notes_dir):
    (notes_dir / "ann-lee.md").write_text("---\ntitle: Ann Lee\ntype: contact\nrole: '[[Senior Engineer]]'\nupdated: 2026-05-05\n---\n\n# Ann Lee\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "contact")
    page.goto(f"{server}/notes/alpha")
    page.keyboard.press("Control+k")
    row = page.locator("note-spotlight .spotlight-item", has_text="Ann Lee")
    expect(row.locator(".spotlight-role")).to_have_text("Senior Engineer")
    expect(page.locator("note-spotlight .spotlight-item", has_text="Alpha").locator(".spotlight-role")).to_have_count(0)


SLOW_SAVES = """
const realFetch = window.fetch;
window.fetch = (url, options) => (options?.method === 'PUT' ? new Promise((resolve) => setTimeout(resolve, 700)).then(() => realFetch(url, options)) : realFetch(url, options));
"""


def test_text_typed_while_a_save_is_in_flight_stays_unsaved(page, server, notes_dir):
    page.add_init_script(SLOW_SAVES)
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" first")
    page.keyboard.press("Control+s")
    expect(page.locator("#save-note-btn .fa-spinner")).to_be_visible()
    page.keyboard.type(" second")  # not part of the request that is already out
    wait_for_commits(notes_dir, 2)
    expect(page.locator("#save-note-btn")).to_be_enabled()  # still unsaved
    assert "second" not in (notes_dir / "beta.md").read_text()
    page.keyboard.press("Control+s")
    wait_until(lambda: "second" in (notes_dir / "beta.md").read_text())
    expect(page.locator("#save-note-btn")).to_be_disabled()
    assert page.errors == []


def test_a_save_that_renames_the_file_keeps_the_editor_caret_and_undo_history(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+Home")
    page.keyboard.type("# Gamma Note\n\n")  # beta has no heading yet: this one names the file
    page.keyboard.press("Control+End")
    page.keyboard.type(" tail")
    page.evaluate("window.__editor = document.querySelector('.cm-editor')")
    page.keyboard.press("Control+s")
    page.wait_for_url("**/notes/gamma-note?mode=edit")
    expect(page.locator("#save-note-btn")).to_be_disabled()
    assert page.evaluate("window.__editor === document.querySelector('.cm-editor')")  # the same editor, not a new one
    page.keyboard.type("!")  # typed where the caret was: the end
    assert page.locator(".cm-content").inner_text().rstrip().endswith("tail!")
    page.keyboard.press("Control+z")  # the undo history survived the save: the last typing is undone, the heading stays
    text = page.locator(".cm-content").inner_text()
    assert "tail!" not in text and text.startswith("# Gamma Note")
    assert page.errors == []


def test_shortcuts_are_ignored_while_a_drawer_is_open(page, server, property_notes):
    page.goto(f"{server}/notes/fix-it")
    page.click("#note-properties-btn")
    expect(page.locator(".notes-properties-drawer")).to_have_count(1)
    page.keyboard.press("Control+Shift+P")  # would stack a second drawer
    page.keyboard.press("Control+e")  # would switch to the editor behind the drawer
    page.wait_for_timeout(300)
    expect(page.locator(".notes-properties-drawer")).to_have_count(1)
    expect(page.locator("#edit-note-btn")).to_have_attribute("aria-pressed", "false")
    assert page.errors == []


def test_saving_over_a_change_made_elsewhere_asks_before_overwriting(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" mine")
    path = notes_dir / "beta.md"
    path.write_text(path.read_text() + "\nadded in another editor\n")  # the file changes after the page loaded it
    page.keyboard.press("Control+s")
    expect(page.locator(".confirm-dialog-host .modal-title")).to_have_text("Note changed elsewhere")
    assert "mine" not in path.read_text()  # nothing was written
    page.click("[data-action=cancel]")  # keep editing: still unsaved, the other change is still there
    expect(page.locator("#save-note-btn")).to_be_enabled()
    assert "added in another editor" in path.read_text()

    page.keyboard.press("Control+s")
    page.click("[data-action=confirm]")  # overwrite
    wait_until(lambda: "mine" in path.read_text())
    expect(page.locator("#save-note-btn")).to_be_disabled()
    assert "added in another editor" not in path.read_text()  # replaced, as the dialog said
    assert all("412" in e or "Save failed" in e or "Precondition" in e for e in page.errors)  # only the refusal we provoked


def test_escape_in_the_restore_confirmation_closes_only_the_confirmation(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha")
    page.click("#note-versions-btn")
    page.locator(".hive-version-row").first.click()
    expect(page.locator("#version-restore")).to_be_enabled()
    page.click("#version-restore")
    expect(page.locator("[data-action=confirm]")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.locator("[data-action=confirm]")).to_have_count(0)
    expect(page.locator("#version-detail")).to_be_visible()  # still on the version, not stepped back to the list
    assert page.errors == []


def test_browser_back_asks_before_dropping_unsaved_edits(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha")
    page.click('#notes-md a.notes-wikilink[data-target="beta"]')
    page.wait_for_url("**/notes/beta")
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("unsaved words")
    page.go_back()
    expect(page.locator(".confirm-dialog-host .modal-title")).to_have_text("Unsaved changes")  # asked first
    page.click("[data-action=cancel]")
    assert page.url.endswith("/notes/beta?mode=edit")  # the address went back to the note being edited
    assert "unsaved words" in page.locator(".cm-content").inner_text()
    expect(page.locator("#save-note-btn")).to_be_enabled()

    page.go_back()  # asked again; this time discard and go where Back pointed
    page.click("[data-action=confirm]")
    page.wait_for_url("**/notes/alpha")
    expect(page.locator("app-header")).to_have_attribute("heading", "Alpha")
    assert "unsaved words" not in (notes_dir / "beta.md").read_text()


def test_closing_the_properties_drawer_with_edits_asks_first(page, server, property_notes):
    page.goto(f"{server}/notes/fix-it")
    page.click("#note-properties-btn")
    drawer = page.locator(".notes-properties-drawer")
    page.keyboard.press("Escape")  # nothing edited: closes at once
    expect(drawer).to_have_count(0)

    page.click("#note-properties-btn")
    pick_field(drawer, "project", "Acme")
    page.keyboard.press("Escape")
    expect(page.locator(".confirm-dialog-host .modal-title")).to_have_text("Unsaved changes")
    page.click(".confirm-dialog-host [data-action=cancel]")  # keep editing
    expect(drawer.locator('[data-key="project"] .combobox-input')).to_have_value("Acme")
    drawer.locator('[data-action="cancel"]').click()  # the drawer's own Cancel asks too
    page.click(".confirm-dialog-host [data-action=confirm]")  # discard
    expect(drawer).to_have_count(0)
    assert "project" not in (property_notes / "fix-it.md").read_text()
    assert page.errors == []


def test_log_time_dialog_lists_logged_days_and_removes_one_in_a_commit(page, server, notes_dir):
    (notes_dir / "ship-it.md").write_text("---\ntitle: Ship it\ntype: task\ntime: {2026-11-19: 90, 2026-11-20: 30}\nupdated: 2026-11-20\n---\n\n# Ship it\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "task with time")
    page.request.post(f"{server}/api/reindex")
    commits = len(git(notes_dir, "rev-list", "HEAD").split())
    page.goto(f"{server}/notes/ship-it")
    expect(page.locator(".stat-logged")).to_contain_text("2h logged")
    page.click("#log-time-btn")
    days = page.locator(".log-time-days li")
    expect(days).to_have_count(2)
    expect(days.first).to_contain_text("Nov 20")  # newest day first
    expect(days.last).to_contain_text("1h 30m")
    page.wait_for_function("document.activeElement.classList.contains('combobox-input')")  # focus ends up on the fields, not on Log time (the dialog moves it as it opens)

    page.click('[data-remove="2026-11-19"]')
    expect(days).to_have_count(1)
    expect(page.locator(".stat-logged")).to_contain_text("30m logged")  # the footer follows
    assert len(git(notes_dir, "rev-list", "HEAD").split()) == commits + 1
    assert "2026-11-19" not in (notes_dir / "ship-it.md").read_text()
    page.click('[data-remove="2026-11-20"]')
    expect(page.locator(".log-time-days")).to_be_hidden()
    expect(page.locator(".stat-logged")).to_be_hidden()
    assert page.errors == []


def test_history_filter_finds_versions_older_than_the_first_page(page, server, notes_dir):
    (notes_dir / "busy.md").write_text("---\ntitle: Busy\ntype: task\nupdated: 2026-11-01\n---\n\n# Busy\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "busy")
    page.request.post(f"{server}/api/reindex")
    page.request.put(f"{server}/api/notes/busy/time/2026-11-20", data={"minutes": 30})  # the one time change, oldest
    for i in range(35):  # more than a page (30) of text edits after it
        page.request.put(f"{server}/api/notes/busy", data={"content": f"# Busy\n\nedit {i}\n"})
    page.goto(f"{server}/notes/busy")
    page.click("#note-versions-btn")
    expect(page.locator(".hive-version-row")).to_have_count(30)
    page.click("[data-tab=time]")
    rows = page.locator(".hive-version-row")
    expect(rows).to_have_count(1)  # found without paging through the text edits
    expect(rows.first).to_contain_text("Logged 30m")
    expect(page.locator("#version-list")).not_to_have_attribute("aria-live", "polite")
    rows.first.click()  # a filtered version opens like any other
    expect(page.locator("#version-detail")).to_be_visible()
    assert page.errors == []


def test_a_second_type_is_added_as_a_chip_and_saved_as_a_list(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha?mode=edit")
    page.wait_for_selector(".cm-content")
    kind = page.locator("#note-type")
    for label in ("Task", "Meeting"):
        kind.locator(".combobox-input").click()
        kind.locator(".combobox-option", has_text=label).first.click()
    expect(kind.locator(".combobox-chip-label")).to_have_text(["Task", "Meeting"])
    kind.locator(".combobox-input").fill("Idea Pad")  # a type nobody has used yet can be typed
    kind.locator(".combobox-input").press("Enter")
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    assert "\ntype: [task, meeting, Idea Pad]\n" in (notes_dir / "alpha.md").read_text()
    kind.locator(".combobox-chip", has_text="Meeting").locator(".combobox-chip-remove").click()
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 3)
    assert "\ntype: [task, Idea Pad]\n" in (notes_dir / "alpha.md").read_text()
    assert page.errors == []


def test_a_tag_chip_searches_for_the_tag(page, server, notes_dir):
    page.goto(f"{server}/notes/alpha")
    page.click('#note-tags [data-tag="one"]')
    expect(page.locator("note-spotlight .spotlight-input")).to_have_value("one")
    expect(page.locator("note-spotlight .spotlight-item").first).to_contain_text("Alpha")  # the note carrying the tag
    assert page.errors == []


def test_a_tag_changed_by_the_properties_drawer_updates_the_footer_tags(page, server, notes_dir):
    # An older note carries its priority as a tag; saving the priority from the drawer moves it into the `priority` key.
    (notes_dir / "bare.md").write_text("---\ntitle: Bare\ntype: task\ntags: [must, work]\nupdated: 2026-11-21\n---\n\n# Bare\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "bare")
    page.goto(f"{server}/notes/bare")
    expect(page.locator("app-header .task-priority--must")).to_have_text("Must")  # the tag is read as the priority, not shown twice
    expect(page.locator("app-header .spec-pill").filter(has=page.locator(".fa-tag"))).to_have_text(["work"])
    page.click("#note-properties-btn")
    pick_field(page.locator(".notes-properties-drawer"), "priority", "Important")
    page.locator('.notes-properties-drawer [data-action="save"]').click()
    expect(page.locator("app-header .task-priority--important")).to_have_text("Important")
    expect(page.locator("app-header .spec-pill").filter(has=page.locator(".fa-tag"))).to_have_text(["work"])
    assert "priority: important" in (notes_dir / "bare.md").read_text()
    assert page.errors == []


def test_a_note_that_others_link_to_cannot_be_deleted_and_the_dialog_opens_them(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")  # alpha links to [[beta]]
    page.click("#delete-note-btn")
    expect(page.locator(".modal-title")).to_have_text("Cannot Delete Note")
    expect(page.locator("#linked-notes")).to_contain_text("Alpha")
    page.click("#linked-notes a")
    page.wait_for_url("**/notes/alpha")
    expect(page.locator(".modal-title")).to_have_count(0)
    assert (notes_dir / "beta.md").exists()

    page.goto(f"{server}/notes/alpha")  # nobody links to alpha: it can be deleted
    page.click("#delete-note-btn")
    expect(page.locator(".confirm-dialog-host .modal-title")).to_have_text("Delete Note?")
    assert page.errors == []


def test_unsaved_changes_dialog_can_save_and_leave(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" kept words")
    page.keyboard.press("Control+k")
    page.fill("note-spotlight .spotlight-input", "alpha")
    expect(page.locator("note-spotlight .spotlight-item")).to_have_count(1)
    page.keyboard.press("Enter")
    page.click("[data-action=alternate]")  # Save and leave
    page.wait_for_url("**/notes/alpha")
    assert "kept words" in (notes_dir / "beta.md").read_text()

    # Back asks the same question and the same button works there.
    page.go_back()
    page.wait_for_url("**/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" more words")
    page.go_forward()
    page.click("[data-action=alternate]")
    page.wait_for_url("**/notes/alpha")
    assert "more words" in (notes_dir / "beta.md").read_text()
    assert page.errors == []


def test_a_failed_load_stays_on_the_note_and_retries(page, server, notes_dir):
    failing = {"on": True}

    def handle(route):
        if failing["on"]:
            route.fulfill(status=500, content_type="application/json", body='{"detail": "disk on fire"}')
        else:
            route.continue_()

    page.route("**/api/notes/beta", handle)
    page.goto(f"{server}/notes/beta")
    expect(page.locator(".notes-load-error")).to_contain_text("disk on fire")
    assert page.url.endswith("/notes/beta")  # not sent to another note
    failing["on"] = False
    page.click("#retry-load-btn")
    expect(page.locator("#notes-md")).to_contain_text("Beta body text")
    assert page.url.endswith("/notes/beta")


def test_saving_shows_no_toast_and_a_missing_note_says_so(page, server, notes_dir):
    page.goto(f"{server}/notes/beta?mode=edit")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("x")
    page.keyboard.press("Control+s")
    wait_for_commits(notes_dir, 2)
    expect(page.locator("#save-note-btn")).to_be_disabled()  # the button is the confirmation
    assert page.locator(".toast, [class*=toast]").filter(has_text="Saved").count() == 0
    page.goto(f"{server}/notes/nope")
    page.wait_for_url("**/notes/beta")  # the note edited last
    expect(page.get_by_text("does not exist")).to_be_visible()


def test_task_properties_edit_tags_and_keep_the_priority(page, server, property_notes):
    page.goto(f"{server}/notes/fix-it")
    before = len(git(property_notes, "rev-list", "HEAD").split())
    page.click("#note-properties-btn")
    drawer = page.locator(".notes-properties-drawer")
    drawer.locator('app-combobox[data-key="tags"] .combobox-input').click()
    page.keyboard.type("work,")
    drawer.locator(".modal-title").click()  # leaving the field adds the pending text
    drawer.locator('[data-action="save"]').click()
    expect(page.locator(".notes-properties-drawer")).to_have_count(0)
    wait_for_commits(property_notes, before + 1)
    assert "tags: [todo, work]" in (property_notes / "fix-it.md").read_text()
    assert page.errors == []


def test_dashboard_shows_stat_cards_and_the_container_processes(page, server):
    page.goto(f"{server}/dashboard")
    cards = page.locator(".dash-grid stat-card[data-metric]")
    expect(cards).to_have_count(4)
    expect(page.locator('stat-card[data-metric="storage"]')).to_have_attribute("title", "Storage")
    expect(page.locator('stat-card[data-metric="uptime"]')).to_have_count(0)
    sizes = page.locator('stat-card[data-metric="storage"] .sub-size')
    expect(sizes).to_have_count(1, timeout=30000)  # what is free on the disk, in the colour of how full it is
    expect(page.locator('stat-card[data-metric="storage"]')).to_contain_text("free of")
    rows = page.locator("app-table tbody tr")
    expect(rows.first).to_be_visible()
    expect(page.locator("app-table th", has_text="PID")).to_be_visible()
    page.locator("app-table th", has_text="Memory").click()  # a server-side sort reloads the page without errors
    expect(rows.first).to_be_visible()
    assert page.errors == []


def test_dashboard_opens_on_the_debian_tab_and_switches_to_agents_without_a_reload(page, agents_server):
    page.goto(f"{agents_server}/dashboard")
    tabs = page.locator("dashboard-app app-tab-bar .tab-bar-item")
    expect(tabs).to_have_text(["Debian", "Agents", "Colab"])
    expect(tabs.first).to_have_class("tab-bar-item tab-bar-item--active")
    expect(page.locator("debian-tab .dash-grid stat-card")).to_have_count(4)
    expect(page.locator("debian-tab app-table tbody tr").first).to_be_visible()  # the stats have loaded
    expect(page.locator("dashboard-app .dash-status")).to_have_text("")  # no "Updated 15:06:55" in the header
    expect(page.locator("agents-tab")).to_have_count(0)
    page.evaluate("window.__same = true")
    tabs.nth(1).click()
    expect(page.locator("agents-tab .card[data-provider]")).to_have_count(3)
    expect(page.locator("debian-tab")).to_have_count(0)  # a tab that is not shown is not in the page, so it does not poll
    assert page.url.endswith("/dashboard/agents") and page.evaluate("window.__same") is True
    expect(page.locator("app-sidebar .nav-link.active")).to_have_text("Dashboard")
    page.go_back()
    expect(page.locator("debian-tab")).to_have_count(1)
    expect(tabs.first).to_have_class("tab-bar-item tab-bar-item--active")
    assert page.errors == []


def test_dashboard_tabs_are_links_that_open_in_a_new_tab_and_switch_in_place_on_a_plain_click(page, agents_server):
    page.goto(f"{agents_server}/dashboard")
    tabs = page.locator("dashboard-app app-tab-bar a.tab-bar-item")
    expect(tabs).to_have_count(3)
    assert [tabs.nth(i).get_attribute("href") for i in range(3)] == ["/dashboard", "/dashboard/agents", "/dashboard/colab"]
    with page.context.expect_page() as opened:
        tabs.nth(1).click(modifiers=["Control"])
    assert opened.value.url.endswith("/dashboard/agents")
    opened.value.close()
    assert page.url.endswith("/dashboard") and page.locator("debian-tab").count() == 1  # the page it was clicked on did not move
    tabs.nth(1).click()
    expect(page.locator("agents-tab")).to_have_count(1)
    assert page.url.endswith("/dashboard/agents")
    assert page.errors == []


def test_agents_tab_opens_directly_and_shows_a_card_per_provider_the_trend_and_the_sessions(page, agents_server):
    page.goto(f"{agents_server}/dashboard/agents")
    expect(page.locator("dashboard-app app-tab-bar .tab-bar-item").nth(1)).to_have_class("tab-bar-item tab-bar-item--active")
    cards = page.locator("agents-tab .card[data-provider]")
    expect(cards).to_have_count(3)
    expect(page.locator('.card[data-provider="claude"] .metric.totals dd')).to_have_text("1.05K")
    expect(page.locator('.card[data-provider="antigravity"]')).to_contain_text("0 sessions")
    expect(page.locator("agents-tab .bar")).not_to_have_count(0)
    rows = page.locator("agents-tab app-table tbody tr")
    expect(rows).to_have_count(3)
    expect(rows.first).to_contain_text("Codex")  # newest activity first
    page.locator("agents-tab app-table th", has_text="Total").click()  # a server-side sort reloads the rows without errors
    expect(rows).to_have_count(3)
    assert page.errors == []


def test_agents_tab_keeps_the_last_report_when_a_refresh_fails(page, agents_server):
    page.goto(f"{agents_server}/dashboard/agents")
    expect(page.locator("agents-tab .card[data-provider]")).to_have_count(3)
    page.route("**/api/agents/usage", lambda route: route.abort())
    page.evaluate("document.querySelector('agents-tab').load()")
    expect(page.locator("dashboard-app .dash-status")).to_have_text("Could not refresh the usage; showing the last report.")
    expect(page.locator("agents-tab .card[data-provider]")).to_have_count(3)
    expect(page.locator("agents-tab app-table tbody tr")).to_have_count(3)
    page.unroute("**/api/agents/usage")
    page.evaluate("document.querySelector('agents-tab').load()")
    expect(page.locator("dashboard-app .dash-status")).to_have_text("")


@pytest.mark.parametrize("failed_section", ["usage", "sessions"])
def test_agents_tab_loads_each_section_when_the_other_fails(page, agents_server, failed_section):
    endpoint = "**/api/agents/usage" if failed_section == "usage" else "**/api/agents/usage/sessions?*"
    page.route(endpoint, lambda route: route.abort())
    page.goto(f"{agents_server}/dashboard/agents")
    cards = page.locator("agents-tab .card[data-provider]")
    table = page.locator("agents-tab app-table")
    status = page.locator("dashboard-app .dash-status")
    if failed_section == "usage":
        expect(status).to_have_text("Hive could not load the usage report.")
        expect(table.locator("tbody tr")).to_have_count(3)
    else:
        expect(status).to_have_text("Hive could not load the sessions.")
        expect(cards).to_have_count(3)
        expect(table).to_contain_text("Hive could not load the sessions.")

    page.unroute(endpoint)
    page.locator("agents-tab").evaluate("(tab) => tab.load()")
    expect(status).to_have_text("")
    expect(cards).to_have_count(3)
    expect(table.locator("tbody tr")).to_have_count(3)


def test_debian_process_table_recovers_after_a_failed_request(page, server):
    page.goto(f"{server}/dashboard")
    tab = page.locator("debian-tab")
    table = tab.locator("app-table")
    rows = table.locator("tbody tr")
    expect(table).not_to_have_attribute("aria-busy", "")
    expect(rows.first).to_be_visible()
    endpoint = "**/api/system/processes?*"
    page.route(endpoint, lambda route: route.fulfill(status=503, json={"detail": "Process data unavailable"}))
    status = page.locator("dashboard-app .dash-status")
    previous_rows = rows.all_text_contents()
    tab.evaluate("(tab) => tab.loadProcesses()")
    expect(status).to_contain_text("Process data unavailable")
    assert rows.all_text_contents() == previous_rows

    page.unroute(endpoint)
    tab.evaluate("(tab) => tab.loadProcesses()")
    expect(status).to_have_text("")
    expect(table).not_to_have_attribute("aria-busy", "")
    expect(rows.first).to_be_visible()


def test_debian_tab_shows_each_process_state_and_how_long_it_has_run(page, server):
    page.goto(f"{server}/dashboard")
    expect(page.locator("debian-tab app-table th", has_text="Status")).to_be_visible()
    expect(page.locator("debian-tab app-table th", has_text="Running")).to_be_visible()
    expect(page.locator("debian-tab app-table tbody tr").first).not_to_contain_text("Up ")


@pytest.mark.parametrize("path, api_prefix", [("/dashboard", "/api/system/"), ("/dashboard/agents", "/api/agents/")])
def test_a_dashboard_tab_opened_in_a_hidden_page_polls_nothing_until_it_is_shown(page, agents_server, path, api_prefix):
    page.add_init_script("Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden !== false })")
    requests = []
    page.on("request", lambda r: api_prefix in r.url and requests.append(r.url))
    page.goto(f"{agents_server}{path}")
    page.wait_for_timeout(1000)
    assert requests == []
    page.evaluate("window.__hidden = false; document.dispatchEvent(new Event('visibilitychange'))")
    deadline = time.time() + 5
    while time.time() < deadline and not requests:
        time.sleep(0.05)
    assert requests  # shown: it loads at once


def test_agents_tab_says_how_old_the_report_is(page, agents_server):
    page.goto(f"{agents_server}/dashboard/agents")
    expect(page.locator("agents-tab time.updated")).to_have_text("Updated just now")
    assert page.errors == []


def test_agents_tab_draws_the_quota_rings_with_their_tooltip(page, agents_server):
    page.goto(f"{agents_server}/dashboard/agents")
    donuts = page.locator("agents-tab .quota-donut")
    expect(donuts).to_have_count(2)  # Claude and Codex have a reading; Antigravity has none, so no ring
    expect(page.locator('.card[data-provider="antigravity"] .quota-donut')).to_have_count(0)
    claude = page.locator('.card[data-provider="claude"] .quota-donut')
    expect(claude.locator("circle.arc")).to_have_count(2)  # 5 hour and weekly
    expect(claude).to_have_attribute("aria-label", "Claude Code Quota")
    claude.hover()
    tip = page.locator("app-tooltip")
    expect(tip).to_be_attached()
    text = page.evaluate("document.querySelector('app-tooltip').shadowRoot.textContent")
    assert "5 hour" in text and "60%" in text and "Weekly" in text and "71%" in text  # what is left, not what is used
    assert page.errors == []


def test_agents_tab_copies_a_resume_command(page, agents_server):
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.goto(f"{agents_server}/dashboard/agents")
    page.locator("agents-tab .session-resume").first.click()
    assert page.evaluate("navigator.clipboard.readText()") == "codex resume sess-b"
    assert page.errors == []


class _Colab:
    """A fake Colab: what `colab sessions` and `colab usage` say, and the snapshot a probe returns."""

    def __init__(self):
        from src.domain.colab.errors import ColabCliError
        self.error_type = ColabCliError
        self.sessions = [{"name": "sentinel-run", "runtime_id": "m-s-1", "hardware": "GPU", "shape": "Standard", "variant": "T4"}]
        self.usage = {"balance": 499.97, "balance_unit": "compute units", "usage_rate": 0.08, "usage_rate_unit": "/hr", "active_assignments": 1}
        self.failure = None
        self.usage_failure = None  # only `colab usage` fails: the runtimes are still listed
        self.kernel = "idle"
        self.snapshot = {
            "stats": {"cpu_count": 2, "cpu_percent": 12.5, "load_average": {"1min": 1.14, "5min": 0.73, "15min": 0.38}, "uptime": "1:05",
                      "memory": {"used_gb": 1.2, "total_gb": 12.7, "percent": 9.4}, "disk": {"used_gb": 30.0, "total_gb": 100.0, "percent": 30.0}, "gpu": []},
            "processes": [{"pid": n, "name": f"proc{n}", "cmdline": "", "command": f"proc{n}", "running_for": "01:00", "cpu_percent": float(n), "mem_percent": 1.0, "mem": "10.0 MB", "status": "running"}
                          for n in range(1, 13)]}


@pytest.fixture
def colab_server(notes_dir, monkeypatch):
    from unittest.mock import AsyncMock
    from src.api.routes import colab as colab_routes
    from src.application.colab.collector import ColabCollector
    fake = _Colab()

    async def sessions():
        if fake.failure:
            raise fake.error_type(fake.failure)
        return fake.sessions

    async def usage():
        if fake.failure or fake.usage_failure:
            raise fake.error_type(fake.failure or fake.usage_failure)
        return fake.usage

    async def kernel_state(name, runtime_id):
        return fake.kernel
    monkeypatch.setattr(colab_routes, "get_colab_sessions", sessions)
    monkeypatch.setattr(colab_routes, "get_colab_usage", usage)
    collector = ColabCollector(sessions=sessions, kernel_state=kernel_state, collect=AsyncMock(side_effect=lambda name: fake.snapshot), grace=0.2)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir, colab=collector), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    yield SimpleNamespace(url=f"http://127.0.0.1:{port}", fake=fake, collector=collector)
    srv.should_exit = True
    thread.join(5)


def test_colab_tab_shows_usage_the_runtime_its_live_stats_and_processes(page, colab_server):
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator("dashboard-app app-tab-bar .tab-bar-item").nth(2)).to_have_class("tab-bar-item tab-bar-item--active")
    expect(page.locator('colab-tab stat-card[data-metric="balance"]')).to_have_attribute("value", "499.97")
    expect(page.locator('colab-tab stat-card[data-metric="rate"]')).to_have_attribute("value", "0.08/hr")
    expect(page.locator(".colab-picker-name")).to_have_text("sentinel-run")
    expect(page.locator(".colab-picker-runtime span").first).to_have_text("m-s-1")
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).to_have_attribute("value", "12.5%", timeout=15000)  # the first probe has arrived
    expect(page.locator('colab-tab stat-card[data-metric="memory"]')).to_have_attribute("sub", "of 12.7 GB (9.4%)")
    expect(page.locator('colab-tab stat-card[data-metric="uptime"]')).to_have_attribute("value", "1h 05m")
    rows = page.locator("colab-tab app-table tbody tr")
    expect(rows).to_have_count(10)  # twelve processes, ten to a page
    expect(rows.first).to_contain_text("proc12")  # highest CPU first
    expect(page.locator("colab-tab app-pagination")).to_be_visible()
    page.locator("colab-tab app-table th", has_text="Memory").click()  # a sort is made here, with no request
    expect(rows).to_have_count(10)
    page.locator("colab-tab .proc-filter").fill("proc12")
    expect(rows).to_have_count(1)
    expect(rows.first).to_contain_text("proc12")
    page.locator("colab-tab .proc-filter").fill("")
    expect(rows).to_have_count(10)
    expect(page.locator("dashboard-app .dash-status")).to_have_text("")
    card, chip = (page.locator(sel).bounding_box() for sel in ('colab-tab stat-card[data-metric="assignments"]', "colab-tab .colab-picker-trigger"))
    assert chip["x"] + chip["width"] <= card["x"] + card["width"]  # the runtime chip is cut short, never wider than its card
    grid = page.locator('colab-tab [data-grid="usage"]').bounding_box()
    assert card["x"] + card["width"] <= grid["x"] + grid["width"] + 1
    assert page.errors == []


def test_colab_tab_without_a_runtime_says_so_and_starts_no_probe(page, colab_server):
    colab_server.fake.sessions = []
    colab_server.fake.usage = {**colab_server.fake.usage, "active_assignments": 0, "usage_rate": 0.0}
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator(".colab-idle")).to_be_visible()
    expect(page.locator(".colab-idle")).to_contain_text("colab new")
    expect(page.locator(".colab-session")).to_be_hidden()
    expect(page.locator('colab-tab stat-card[data-metric="rate"]')).to_have_attribute("sub", "Idle")
    expect(page.locator('colab-tab stat-card[data-metric="uptime"]')).to_have_attribute("sub", "No active session")
    time.sleep(0.5)
    assert colab_server.collector.feeds == {}  # nothing asked the runtime anything
    assert page.errors == []


def test_colab_tab_says_when_the_cli_cannot_be_reached(page, colab_server):
    colab_server.fake.failure = "colab CLI is not installed or not on PATH"
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator("dashboard-app .dash-status")).to_have_text("colab CLI is not installed or not on PATH")
    expect(page.locator("dashboard-app .dash-status")).to_have_class("dash-status error")
    expect(page.locator('colab-tab stat-card[data-metric="balance"]')).to_have_attribute("sub", "Unable to read")
    expect(page.locator('colab-tab stat-card[data-metric="assignments"]')).to_have_attribute("sub", "Unable to read")
    expect(page.locator(".colab-idle h3")).to_have_text("Unable to read Colab sessions")
    assert page.errors == []


def test_colab_tab_keeps_the_selected_runtime_during_a_failed_sessions_poll(page, colab_server):
    page.goto(f"{colab_server.url}/dashboard/colab")
    cpu = page.locator('colab-tab stat-card[data-metric="cpu"]')
    expect(cpu).to_have_attribute("value", "12.5%", timeout=15000)
    process_filter = page.locator("colab-tab .proc-filter")
    process_filter.fill("proc12")
    status = page.locator("dashboard-app .dash-status")
    original_stream = page.locator("colab-tab").evaluate_handle("(tab) => tab.source")

    sessions_url = "**/api/colab/sessions"
    page.route(sessions_url, lambda route: route.fulfill(json={"reachable": False, "sessions": [], "error": "Colab sessions timed out"}))
    page.locator("colab-tab").evaluate("(tab) => tab.poll()")
    expect(status).to_have_text("Colab sessions timed out")
    expect(page.locator(".colab-picker-name")).to_have_text("sentinel-run")
    expect(cpu).to_have_attribute("value", "12.5%")
    expect(process_filter).to_have_value("proc12")
    expect(page.locator("colab-tab app-table tbody")).to_contain_text("proc12")
    assert page.locator("colab-tab").evaluate("(tab, source) => tab.source === source", original_stream)

    page.unroute(sessions_url)
    initial_session = colab_server.fake.sessions[0]
    replacement = {**initial_session, "name": "another-run", "runtime_id": "m-s-2"}
    colab_server.fake.sessions = [replacement, initial_session]
    page.locator("colab-tab").evaluate("(tab) => tab.poll()")
    expect(status).to_have_text("")
    expect(page.locator(".colab-picker-name")).to_have_text("sentinel-run")
    expect(process_filter).to_have_value("proc12")

    colab_server.fake.sessions = [replacement]
    page.locator("colab-tab").evaluate("(tab) => tab.poll()")
    expect(page.locator(".colab-picker-name")).to_have_text("another-run")
    expect(process_filter).to_have_value("")


def test_colab_tab_says_why_usage_is_unreadable_even_with_a_runtime_selected(page, colab_server):
    colab_server.fake.usage_failure = "colab usage timed out"
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator(".colab-picker-name")).to_have_text("sentinel-run")
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).to_have_attribute("value", "12.5%", timeout=15000)  # the live stats still work
    expect(page.locator("dashboard-app .dash-status")).to_have_text("colab usage timed out")
    expect(page.locator("dashboard-app .dash-status")).to_have_class("dash-status error")
    assert page.errors == []


def test_colab_tab_says_why_there_is_no_data_when_the_kernel_is_busy_before_the_first_probe(page, colab_server):
    colab_server.fake.kernel = "busy"
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator("colab-tab .colab-session app-table")).to_contain_text("Notebook kernel is busy")  # not a spinner for ever
    expect(page.locator("colab-tab .colab-session app-table")).not_to_have_attribute("aria-busy", "true")
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).not_to_have_attribute("loading", "")
    assert page.errors == []


def test_colab_tab_offers_a_reconnect_when_the_live_stream_cannot_open_and_recovers(page, colab_server):
    page.route("**/api/colab/stream*", lambda route: route.fulfill(status=409, content_type="application/json", body='{"detail": "colab sessions timed out"}'))
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator(".colab-picker-name")).to_have_text("sentinel-run")
    expect(page.locator(".colab-live")).to_be_visible()  # the browser gave up on the stream: a way back, not a silent wait
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).not_to_have_attribute("value", "12.5%")
    page.unroute("**/api/colab/stream*")
    page.locator(".colab-reconnect").click()
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).to_have_attribute("value", "12.5%", timeout=15000)
    expect(page.locator(".colab-live")).to_be_hidden()


def test_leaving_the_colab_tab_stops_the_probing(page, colab_server):
    page.goto(f"{colab_server.url}/dashboard/colab")
    expect(page.locator('colab-tab stat-card[data-metric="cpu"]')).to_have_attribute("value", "12.5%", timeout=15000)
    assert len(colab_server.collector.feeds["m-s-1"].viewers) == 1
    page.locator("dashboard-app app-tab-bar .tab-bar-item").first.click()  # Debian
    expect(page.locator("colab-tab")).to_have_count(0)
    deadline = time.time() + 5
    while time.time() < deadline and colab_server.collector.feeds["m-s-1"].viewers:
        time.sleep(0.05)
    assert not colab_server.collector.feeds["m-s-1"].viewers  # the stream closed, so the grace period starts
    time.sleep(0.6)
    assert colab_server.collector.feeds["m-s-1"].task.done()  # and then the collector itself stops


# --- Chat ----------------------------------------------------------------------------------------------------------------

class ChatRunner:
    """Stands in for Codex: it records the prompt and answers like a run that read one note and saved another."""

    def __init__(self, notes_dir):
        self.notes_dir, self.prompts, self.gate = notes_dir, [], threading.Event()
        self.gate.set()

    def run(self, prompt, session=None):
        from src.application.chat.tools import NotesTools
        self.prompts.append(prompt)
        yield {"type": "message", "text": "Let me look."}
        yield {"type": "step", "id": "1", "tool": "read_note", "label": "Reading alpha", "write": False, "status": "running"}
        yield {"type": "step", "id": "1", "tool": "read_note", "label": "Reading alpha", "write": False, "status": "done"}
        self.gate.wait(10)
        question = prompt.rsplit("Question from the user", 1)[1]
        if "tidy" in question:
            NotesTools(self.service).call("append_to_note", {"slug": "beta", "text": "Tidied."})
            yield {"type": "step", "id": "2", "tool": "append_to_note", "label": "Adding to beta", "write": True, "status": "done"}
        if "polish" in question:  # the note the chat sits beside
            NotesTools(self.service).call("append_to_note", {"slug": "alpha", "text": "Polished."})
            yield {"type": "step", "id": "2", "tool": "append_to_note", "label": "Adding to alpha", "write": True, "status": "done"}
        if "addrow" in question:  # a table note gets a row
            note = self.service.get("inventory")
            self.service.update("inventory", content=note.content.replace("| Bo Kim | HP |", "| Bo Kim | HP |\n| Cy Doe | Apple |", 1))
            yield {"type": "step", "id": "2", "tool": "edit_note", "label": "Editing inventory", "write": True, "status": "done"}
        if "addphase" in question:  # a timeline note gets a phase
            NotesTools(self.service).call("append_to_note", {"slug": "roadmap", "text": "## September 2025 — Ship\n\nShipped."})
            yield {"type": "step", "id": "2", "tool": "append_to_note", "label": "Adding to roadmap", "write": True, "status": "done"}
        if "retitle" in question:  # a new heading renames the file
            self.service.update("alpha", content=self.service.get("alpha").content.replace("# Alpha", "# Alpha Two", 1))
            yield {"type": "step", "id": "2", "tool": "edit_note", "label": "Editing alpha", "write": True, "status": "done"}
        yield {"type": "message", "text": "Alpha links to [[beta]] and has **code**."}
        yield {"type": "done", "usage": {}}


@pytest.fixture
def chat_server(notes_dir):
    runner = ChatRunner(notes_dir)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    app = create_app(notes_dir, chat_runner=runner)
    runner.service = app.state.notes
    srv = uvicorn.Server(uvicorn.Config(app, port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    yield SimpleNamespace(url=f"http://127.0.0.1:{port}", runner=runner, root=notes_dir)
    runner.gate.set()
    srv.should_exit = True
    thread.join(5)


def test_chat_answers_with_steps_links_and_follow_ups_that_remember_the_conversation(page, chat_server):
    page.goto(f"{chat_server.url}/chat")
    expect(page.locator("app-sidebar .nav-link.active")).to_have_text("Chat")
    expect(page.locator(".chat-empty")).to_be_visible()
    page.locator(".chat-suggestion").first.click()  # a suggestion sends it at once
    expect(page.locator(".chat-message.user .chat-user-text")).to_have_text("What are my open tasks, most urgent first?")
    expect(page.locator(".chat-message.user .chat-avatar")).to_have_text("RT")  # the sidebar's avatar, not a generic icon
    expect(page.locator(".chat-message.user .chat-avatar")).to_have_css("background-color", page.locator("app-sidebar .sidebar-profile-avatar").evaluate("e => getComputedStyle(e).backgroundColor"))
    answer = page.locator(".chat-message.assistant .chat-answer")
    expect(answer).to_contain_text("Alpha links to")
    expect(answer.locator("strong")).to_have_text("code")
    work = page.locator(".chat-message.assistant .chat-work")
    expect(work.locator("summary")).to_contain_text("Worked")  # the finished work folds into one line
    expect(work.locator("summary")).to_contain_text("1 step")
    expect(work.locator(".chat-steps li").first).not_to_be_visible()
    work.locator("summary").click()
    expect(work.locator(".chat-steps li").first).to_have_text("Let me look.")  # earlier text is narration, not the answer
    expect(work.locator(".chat-steps li", has_text="Reading alpha")).to_be_visible()
    work.locator("summary").click()
    expect(work.locator(".chat-steps li").first).not_to_be_visible()
    expect(answer.locator("a.notes-wikilink")).to_have_attribute("href", "/notes/beta")  # [[beta]] resolved to the note
    page.locator("#chat-input").fill("and the second?")
    page.locator("#chat-input").press("Enter")
    expect(page.locator(".chat-message.assistant")).to_have_count(2)
    expect(page.locator(".chat-message.assistant .chat-answer").nth(1)).to_contain_text("Alpha links to")
    last = chat_server.runner.prompts[-1]
    assert "User: What are my open tasks" in last and "Assistant: Alpha links to" in last and last.endswith("and the second?")
    # the conversation is kept in this browser: leaving the page and coming back (or reloading) shows it again
    page.goto(f"{chat_server.url}/notes/alpha")
    page.goto(f"{chat_server.url}/chat")
    expect(page.locator(".chat-message")).to_have_count(4)
    expect(page.locator(".chat-message.user .chat-user-text").nth(1)).to_have_text("and the second?")
    expect(page.locator(".chat-message.assistant .chat-answer").first).to_contain_text("Alpha links to")
    page.reload()
    expect(page.locator(".chat-message")).to_have_count(4)
    page.locator("#chat-input").fill("a third")
    page.locator("#chat-input").press("Enter")  # a follow-up after coming back still sends the earlier turns
    expect(page.locator(".chat-message.assistant")).to_have_count(3)
    expect(page.locator(".chat-message.assistant .chat-answer").nth(2)).to_contain_text("Alpha links to")  # the run has finished
    assert "User: and the second?" in chat_server.runner.prompts[-1]
    page.locator("#chat-new").click()  # only "New chat" forgets
    expect(page.locator(".chat-message")).to_have_count(0)
    expect(page.locator(".chat-empty")).to_be_visible()
    page.reload()
    expect(page.locator(".chat-message")).to_have_count(0)


def test_chat_follows_the_newest_message_to_the_bottom(page, chat_server):
    page.set_viewport_size({"width": 1100, "height": 420})
    page.goto(f"{chat_server.url}/chat")
    box = page.locator("#chat-input")
    for i in range(5):
        box.fill(f"question number {i}")
        box.press("Enter")
        expect(page.locator(".chat-message.assistant .chat-answer")).to_have_count(i + 1)
    gap = "() => { const s = document.querySelector('#chat-scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight; }"
    assert page.evaluate("() => { const s = document.querySelector('#chat-scroll'); return s.scrollHeight > s.clientHeight; }")
    assert page.evaluate(gap) < 5
    page.evaluate("() => { document.querySelector('#chat-scroll').scrollTop = 0; }")  # reading older text: do not drag back down
    box.fill("one more")
    box.press("Enter")  # sending is the reader's own move, so it goes to the bottom again
    expect(page.locator(".chat-message.assistant .chat-answer")).to_have_count(6)
    assert page.evaluate(gap) < 5


def test_chat_edits_are_reported_as_changed_notes_that_open(page, chat_server):
    page.goto(f"{chat_server.url}/chat")
    page.locator("#chat-input").fill("please tidy beta")
    page.locator("#chat-send").click()
    changed = page.locator(".chat-changed a")
    expect(changed).to_have_text("Beta Note")
    assert "Tidied." in (chat_server.root / "beta.md").read_text()
    assert git(chat_server.root, "log", "-1", "--format=%s").strip() == "doc: update Beta Note"
    expect(page.locator(".chat-work summary .chat-work-wrote")).to_be_visible()  # a run that saved something says so on the closed line
    expect(page.locator(".chat-work summary")).to_contain_text("changed 1 note")
    page.locator(".chat-work summary").click()
    expect(page.locator(".chat-steps li.write")).to_have_text("Adding to beta")
    changed.click()
    expect(page).to_have_url(f"{chat_server.url}/notes/beta")


def test_chat_can_be_stopped_while_codex_works(page, chat_server):
    chat_server.runner.gate.clear()
    page.goto(f"{chat_server.url}/chat")
    page.locator("#chat-input").fill("slow one")
    page.locator("#chat-send").click()
    expect(page.locator(".chat-steps li", has_text="Reading alpha")).to_be_visible()
    expect(page.locator("#chat-send")).to_have_class("chat-send stop")
    page.locator("#chat-send").click()
    expect(page.locator(".chat-stopped")).to_be_visible()
    expect(page.locator("#chat-send")).to_have_class("chat-send")
    chat_server.runner.gate.set()


def test_chat_says_when_codex_is_missing(page, notes_dir, monkeypatch):
    monkeypatch.setattr("src.api.main.codex_program", lambda configured=None: None)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    try:
        page.goto(f"http://127.0.0.1:{port}/chat")
        expect(page.locator("#chat-notice")).to_contain_text("Codex was not found")
        expect(page.locator("#chat-send")).to_be_disabled()
    finally:
        srv.should_exit = True
        thread.join(5)


def test_chat_left_mid_answer_comes_back_stopped_with_what_it_had(page, chat_server):
    chat_server.runner.gate.clear()
    page.goto(f"{chat_server.url}/chat")
    page.locator("#chat-input").fill("slow one")
    page.locator("#chat-send").click()
    expect(page.locator(".chat-steps li", has_text="Reading alpha")).to_be_visible()
    page.goto(f"{chat_server.url}/notes/alpha")  # leaving closes the stream, which stops Codex
    chat_server.runner.gate.set()
    page.goto(f"{chat_server.url}/chat")
    expect(page.locator(".chat-message.user .chat-user-text")).to_have_text("slow one")
    expect(page.locator(".chat-stopped")).to_be_visible()
    expect(page.locator("#chat-send")).to_have_class("chat-send")  # ready for the next question
    expect(page.locator(".chat-work summary")).to_contain_text("1 step")  # the finished step is folded away
    expect(page.locator(".chat-work[open]")).to_have_count(0)


def test_a_diagram_can_be_downloaded_as_a_png(page, diagram_note, tmp_path):
    png = b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + (400).to_bytes(4, "big") + (300).to_bytes(4, "big") + b"\x08\x06\0\0\0"
    base = FakeRunner()

    def runner(cmd, data, env, timeout):
        done = base(cmd, data, env, timeout)
        return subprocess.CompletedProcess(cmd, 0, png if "-tpng" in cmd else done.stdout, b"")

    with serve(diagram_note, fake_diagrams(tmp_path, diagram_note, runner)) as server:
        page.goto(f"{server}/notes/flows")
        expect(page.locator("#notes-md .notes-diagram-img")).to_have_count(2)
        figure = page.locator("#notes-md .notes-diagram").first
        figure.hover()
        with page.expect_download() as download:
            figure.locator("button.notes-diagram-download").click()
            figure.locator('button[data-download-theme="light"]').click()
        assert download.value.suggested_filename.endswith("-light.png")
        assert open(download.value.path(), "rb").read().startswith(b"\x89PNG")
        # Reopened from the page's cache the diagram is built from markup: the pulldown still works.
        page.goto(f"{server}/notes/alpha")
        page.goto(f"{server}/notes/flows")
        figure = page.locator("#notes-md .notes-diagram").first
        expect(figure.locator(".notes-diagram-img")).to_be_visible()
        figure.hover()
        with page.expect_download() as again:
            figure.locator("button.notes-diagram-download").click()
            figure.locator('button[data-download-theme="dark"]').click()
        assert again.value.suggested_filename.endswith("-dark.png")
        assert page.errors == []


# -- changes made outside the page (SSE) ------------------------------------------------

def test_an_open_note_refreshes_when_its_file_is_edited_outside_hive(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    expect(page.locator("#notes-md")).to_contain_text("Beta body text")
    (notes_dir / "beta.md").write_text("---\ntitle: Beta Note\n---\n\nEdited in an editor\n")  # the watcher sees this
    expect(page.locator("#notes-md")).to_contain_text("Edited in an editor", timeout=5000)
    assert page.errors == []


def test_a_note_with_unsaved_edits_asks_before_taking_the_outside_change(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("my own words ")
    (notes_dir / "beta.md").write_text("---\ntitle: Beta Note\n---\n\nEdited in an editor\n")
    banner = page.locator(".notes-remote-banner")
    expect(banner).to_be_visible(timeout=5000)
    expect(page.locator(".cm-content")).to_contain_text("my own words")  # nothing was thrown away
    banner.get_by_role("button", name="Reload").click()
    expect(page.locator(".cm-content")).to_contain_text("Edited in an editor")
    expect(banner).to_have_count(0)


def test_a_save_from_this_page_is_not_mistaken_for_an_outside_change(page, server, notes_dir):
    page.goto(f"{server}/notes/beta")
    page.click("#edit-note-btn")
    page.wait_for_selector(".cm-content")
    page.click(".cm-content")
    page.keyboard.type("typed ")
    page.keyboard.press("Control+s")
    page.wait_for_timeout(1500)  # the echo of our own save arrives and is recognised by its revision
    expect(page.locator(".notes-remote-banner")).to_have_count(0)
    expect(page.locator(".cm-content")).to_contain_text("typed")
    assert page.errors == []


def test_the_task_board_picks_up_a_task_created_outside_hive(page, server, task_notes):
    page.goto(f"{server}/tasks")
    expect(column(page, "TODO").locator(".board-card-title")).to_have_text(["Write report"])
    (task_notes / "fresh.md").write_text("---\ntitle: Fresh\ntype: task\nstatus: TODO\n---\n\n# Fresh\n")
    expect(column(page, "TODO").locator(".board-card-title")).to_have_text(["Write report", "Fresh"], timeout=5000)
    assert page.errors == []


def test_an_outside_change_keeps_the_reading_position(page, server, notes_dir):
    body = "\n\n".join(f"Paragraph {n} " + "word " * 40 for n in range(80))
    (notes_dir / "long.md").write_text(f"---\ntitle: Long\n---\n\n# Long\n\n{body}\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "long")
    page.goto(f"{server}/notes/long")
    expect(page.locator("#notes-md")).to_contain_text("Paragraph 79")
    page.evaluate("document.querySelector('#notes-preview').scrollTop = 1500")
    before = page.evaluate("document.querySelector('#notes-preview').scrollTop")
    assert before > 1000
    (notes_dir / "long.md").write_text(f"---\ntitle: Long\n---\n\n# Long\n\n{body}\n\nAdded at the end.\n")
    expect(page.locator("#notes-md")).to_contain_text("Added at the end", timeout=5000)
    assert abs(page.evaluate("document.querySelector('#notes-preview').scrollTop") - before) < 5
    assert page.errors == []


def test_an_outside_change_keeps_the_caret_and_scroll_of_a_clean_editor(page, server, notes_dir):
    body = "\n\n".join(f"Paragraph {n} " + "word " * 40 for n in range(80))
    (notes_dir / "long.md").write_text(f"---\ntitle: Long\n---\n\n# Long\n\n{body}\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "long")
    page.goto(f"{server}/notes/long?mode=edit")
    page.wait_for_selector(".cm-content")
    place = """() => {
      const view = document.querySelector('notes-app').cmEditor;
      view.dispatch({ selection: { anchor: 5000 } });
      view.scrollDOM.scrollTop = 1200;
      return [view.state.selection.main.head, view.scrollDOM.scrollTop];
    }"""
    page.evaluate(place)
    page.wait_for_timeout(500)  # CodeMirror settles (it may scroll the caret into view) before we note where things are
    head, scroll = page.evaluate("() => { const v = document.querySelector('notes-app').cmEditor; return [v.state.selection.main.head, v.scrollDOM.scrollTop]; }")
    assert scroll > 500
    (notes_dir / "long.md").write_text(f"---\ntitle: Long\n---\n\n# Long\n\n{body}\n\nAdded at the end.\n")
    # (the editor only draws the lines in view, so look at its document, not at the page text)
    page.wait_for_function("document.querySelector('notes-app').cmEditor?.state.doc.toString().includes('Added at the end')", timeout=5000)
    page.wait_for_timeout(500)
    now = page.evaluate("() => { const v = document.querySelector('notes-app').cmEditor; return [v.state.selection.main.head, v.scrollDOM.scrollTop]; }")
    assert now[0] == head and abs(now[1] - scroll) < 5
    assert page.errors == []


def test_spotlight_on_a_non_notes_page_opens_the_picked_note(page, server):
    page.goto(f"{server}/dashboard")
    page.keyboard.press("Control+k")
    page.fill("note-spotlight .spotlight-input", "beta body")
    expect(page.locator("note-spotlight .spotlight-item")).to_have_count(1)
    page.keyboard.press("Enter")
    page.wait_for_url("**/notes/beta")
    assert page.errors == []


def test_timeline_note_opens_as_phases_and_the_pencil_returns_to_the_editor(page, server, notes_dir):
    (notes_dir / "roadmap.md").write_text(
        "---\ntitle: Roadmap\ntype: timeline\nupdated: 2026-03-03\n---\n\n# Roadmap\n\n"
        "## July 2025 — Kickoff\n\nAligned scope.\n\n- Wrote requirements.\n- Planned delivery.\n\n"
        "## August 2025 — Build\n\nBuilt it.\n\n- Shipped ANPN-1.\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "timeline")

    page.goto(f"{server}/notes/roadmap")
    page.wait_for_url("**/timelines/roadmap")  # a timeline note is read on its own page
    expect(page.locator("app-header")).to_have_attribute("heading", "Roadmap")
    expect(page.locator("app-header #search-notes-btn")).to_be_visible()  # the same search as the note page's header
    cards = page.locator(".timeline-phase")
    expect(cards).to_have_count(2)
    expect(cards.nth(0).locator(".timeline-tasks li")).to_have_count(2)  # every list is shown
    expect(cards.nth(1).locator(".timeline-tasks li")).to_have_text("Shipped ANPN-1.")  # ticket ids stay plain text
    expect(page.locator("button.timeline-phase-head, #timeline-toggle-all")).to_have_count(0)  # nothing collapses
    page.click("#edit-note-btn")
    page.wait_for_url("**/notes/roadmap?mode=edit")
    assert page.errors == []


def test_with_the_chat_open_only_the_task_text_scrolls(page, server, notes_dir):
    sections = "".join(f"## Section {i}\n\n" + "Some text that fills the page. " * 20 + "\n\n" for i in range(12))
    (notes_dir / "long-task.md").write_text(f"---\ntitle: Long task\ntype: task\nupdated: 2026-03-03\n---\n\n# Long task\n\nLead.\n\n{sections}")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "long task")
    page.set_viewport_size({"width": 1400, "height": 800})
    page.goto(f"{server}/tasks/long-task")
    page.wait_for_selector(".task-section")
    page.click("#note-chat-btn")
    expect(page.locator("task-note-app")).to_have_class(re.compile("chat-docked"))
    sizes = page.evaluate("() => { const w = document.querySelector('.spec-workspace'); return { page: document.querySelector('task-note-app').getBoundingClientRect().height, window: innerHeight, text: w.scrollHeight, pane: w.clientHeight }; }")
    assert sizes["page"] <= sizes["window"]  # the page itself does not scroll...
    assert sizes["text"] > sizes["pane"]  # ...the text does
    header = page.locator("app-header").bounding_box()
    pane, bar = page.locator(".spec-workspace").bounding_box(), page.locator(".notes-action-bar").bounding_box()
    assert abs(pane["y"] - (header["y"] + header["height"])) < 2  # the scrollbar starts at the header's border...
    assert abs(pane["y"] + pane["height"] - bar["y"]) < 2  # ...and ends at the footer bar's
    page.locator(".spec-workspace").evaluate("(e) => { e.scrollTop = 600; }")
    assert page.locator("app-header").bounding_box() == header  # the header stays,
    assert abs(page.locator(".notes-chat-dock").bounding_box()["y"] - (header["y"] + header["height"])) < 2  # and so does the chat
    page.keyboard.press("Control+Shift+L")
    expect(page.locator("task-note-app")).not_to_have_class(re.compile("chat-docked"))
    assert page.evaluate("document.querySelector('task-note-app').getBoundingClientRect().height") > page.evaluate("innerHeight")  # closed: the whole page is as tall as its text again
    assert page.errors == []


def test_specification_note_opens_as_requirements_and_the_pencil_returns_to_the_editor(page, server, notes_dir):
    (notes_dir / "spine-users.md").write_text(
        "---\ntitle: 'Spine — Users'\ntype: specification\nstatus: Active\nverified: 2026-01-01\nupdated: 2026-03-03\n---\n\n"
        "# Spine — Users\n\n## Objective\n\nPeople can sign in with a `password`.\n\n## Requirements\n\n"
        "### Sign in\n\nThe system SHALL let a user sign in and MUST verify the `password`.\n\n"
        "- valid `password` -> a `session` starts\n- wrong password -> sign in is refused\n\n"
        "### Sign out\n\nA user can sign out.\n\n## Open Questions\n\n- Single sign-on?\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "specification")

    page.goto(f"{server}/notes/spine-users")
    page.wait_for_url("**/specifications/spine-users")  # a specification note is read on its own page
    expect(page.locator("app-header")).to_have_attribute("heading", "Spine — Users")
    expect(page.locator("app-header #search-notes-btn")).to_be_visible()
    assert page.locator("app-header #search-notes-btn").bounding_box()["width"] < 360  # shorter so the header chips have room
    expect(page.locator("app-header .spec-status")).to_have_text("Active")  # the chips sit in the header, under the heading
    expect(page.locator(".spec-objective code")).to_have_text("password")
    cards = page.locator(".spec-req")
    expect(cards).to_have_count(2)
    expect(cards.nth(0).locator(".spec-scenario")).to_have_count(2)
    expect(cards.nth(0).locator(".spec-sid")).to_have_text(["S1", "S2"])  # numbered, so a review can point at one
    expect(cards.nth(0).locator(".spec-scenario").first.locator(".spec-label")).to_have_text(["When", "Then"])  # two rows each
    expect(cards.nth(0).locator(".spec-statement code")).to_have_text("password")
    expect(cards.nth(0).locator(".spec-when code")).to_have_text("password")
    expect(cards.nth(0).locator(".spec-then code")).to_have_text("session")
    keywords = cards.nth(0).locator(".spec-statement mark")
    expect(keywords).to_have_text(["SHALL", "MUST"])
    for keyword in keywords.all():
        expect(keyword).to_have_css("font-weight", "700")
        expect(keyword).to_have_css("background-color", "rgba(0, 0, 0, 0)")
        assert keyword.evaluate("""el => {
            const actual = getComputedStyle(el).color;
            el.style.color = 'var(--color-orange)';
            const expected = getComputedStyle(el).color;
            el.style.removeProperty('color');
            return actual === expected;
        }""")
    expect(cards.nth(1)).to_have_class(re.compile("spec-req--weak"))  # no SHALL or MUST
    expect(page.locator(".spec-check li")).to_have_count(1)
    assert page.evaluate("Boolean(customElements.get('app-dropdown-menu'))")  # the diagram menu (Download PNG) works here too
    expect(page.locator(".spec-outline a[href='#spec-req-1']")).to_have_text("Sign out")
    page.click("#note-chat-btn")  # the chat docks beside the workspace and the page makes room for it
    expect(page.locator("specifications-app")).to_have_class(re.compile("chat-docked"))
    spec_pane, spec_dock = page.locator(".spec-workspace").bounding_box(), page.locator(".notes-chat-dock").bounding_box()
    assert spec_pane["x"] + spec_pane["width"] <= spec_dock["x"] + 1
    expect(page.locator(".spec-outline")).to_be_hidden()
    page.keyboard.press("Control+Shift+L")
    page.click("#edit-note-btn")
    page.wait_for_url("**/notes/spine-users?mode=edit")
    assert page.errors == []


@pytest.mark.parametrize(("note_type", "route"), [("task", "tasks"), ("specification", "specifications")])
def test_read_pages_show_references_as_a_list(page, server, notes_dir, note_type, route):
    path = "src/" + "long-module-name-" * 80 + ".py"
    (notes_dir / "reference-example.md").write_text(
        f"---\ntitle: Reference example\ntype: {note_type}\n---\n\n"
        "# Reference example\n\n## Objective\n\nDocument the feature.\n\n"
        "## Background\n\nSee [[Alpha]] for context.\n\n"
        "## References\n\n- [Design document](https://example.com/design) — current design\n"
        f"- `{path}`\n"
    )
    page.goto(f"{server}/{route}/reference-example")
    references = page.locator(".spec-section--refs")
    expect(references.get_by_role("heading", name="References")).to_be_visible()
    rows = references.locator(".spec-prose > ul > li")
    expect(rows).to_have_count(2)
    expect(rows.first).to_have_css("list-style-type", "disc")
    expect(rows.first).to_have_css("padding-block-start", "0px")
    expect(rows.first).to_have_css("padding-block-end", "0px")
    expect(rows.nth(1)).to_have_css("border-block-start-width", "0px")
    assert rows.first.bounding_box()["y"] < rows.nth(1).bounding_box()["y"]
    expect(rows.nth(1).locator("code")).to_have_text(path)
    assert rows.nth(1).evaluate("(row) => row.scrollWidth <= row.clientWidth")
    link = rows.first.get_by_role("link", name="Design document")
    expect(link).to_have_css("text-decoration-line", "underline")
    assert link.evaluate("(link) => getComputedStyle(link, '::after').fontFamily") == '"Font Awesome 6 Free"'
    link.focus()
    expect(link).to_have_css("outline-style", "solid")
    wiki_link = page.locator(".spec-prose").get_by_role("link", name="Alpha")
    expect(wiki_link).to_have_attribute("href", "/notes/alpha")
    expect(wiki_link).to_have_css("text-decoration-line", "underline")
    expect(wiki_link).to_have_css("border-top-width", "0px")
    expect(wiki_link).to_have_css("padding-inline-start", "0px")
    assert wiki_link.evaluate("(link) => getComputedStyle(link, '::after').content") == "none"


def test_task_note_opens_as_sections_with_progress_and_the_pencil_returns_to_the_editor(page, server, notes_dir):
    (notes_dir / "fix-login.md").write_text(
        "---\ntitle: Fix login\ntype: task\nstatus: IN_PROGRESS\npriority: must\nproject: CreatorIQ\nticket: APIM-66\ntags: [Auth, must]\nupdated: 2026-03-03\n---\n\n"
        "# Fix login\n\nSafari users cannot sign in. The fix MUST preserve sessions.\n\n## Acceptance Criteria\n\n- [x] The service SHALL set the cookie\n- [ ] Works on Safari with `MUST` in an example\n\n"
        "## Plan\n\n1. **Reproduce.** Use Safari 17.\n2. **Fix the cookie.** Set SameSite.\n\n### Example\n\n```yaml\ncookie:\n  same_site: lax\n```\n\n## Verification\n\nChecked by hand.\n\n## Open Questions\n\n- Which browsers?\n- Remember me?\n\n## Related\n\n- [[Alpha]]\n- [[Beta]]\n")
    git(notes_dir, "add", "-A")
    git(notes_dir, "commit", "-qm", "task")

    page.goto(f"{server}/notes/fix-login")
    page.wait_for_url("**/tasks/fix-login")  # a task note is read on its own page
    expect(page.locator("app-header")).to_have_attribute("heading", "Fix login")
    expect(page.locator("app-header #search-notes-btn")).to_be_visible()
    assert page.locator("app-header #search-notes-btn").bounding_box()["width"] < 360
    expect(page.locator("app-header .task-status--in-progress")).to_have_text("In Progress")
    expect(page.locator("app-header .task-priority--must")).to_have_text("Must")
    expect(page.locator("app-header .task-project")).to_have_text("CreatorIQ")
    ticket = page.locator("app-header .task-ticket")
    expect(ticket).to_have_text("APIM-66")  # opens the Jira task, as the board's ticket chip does
    expect(ticket).to_have_attribute("href", "https://socialedge.atlassian.net/browse/APIM-66")
    expect(ticket).to_have_attribute("target", "_blank")
    expect(page.locator("app-header .spec-pill").filter(has_text="Auth")).to_have_count(1)
    expect(page.locator("app-header .spec-pill").filter(has_text=re.compile("^must$"))).to_have_count(0)  # the priority tag is the priority chip
    expect(page.locator(".task-lead")).to_contain_text("Safari users cannot sign in.")
    keywords = page.locator(".requirement-keyword")
    expect(keywords).to_have_text(["MUST", "SHALL"])
    expect(keywords.first).to_have_css("font-weight", "700")
    expect(keywords.first).to_have_css("background-color", "rgba(0, 0, 0, 0)")
    expect(page.locator(".task-section--criteria code")).to_have_text("MUST")
    expect(page.locator("app-header .task-progress")).to_have_text("1 of 2 done")  # a chip of the header, not a row above the content
    expect(page.locator(".task-section")).to_have_count(5)
    expect(page.locator(".task-section--checks input[type=checkbox]")).to_have_count(2)
    expect(page.locator(".task-section--criteria")).to_have_count(1)  # Acceptance Criteria is drawn as rows
    expect(page.locator(".task-section--criteria li")).to_have_count(2)
    expect(page.locator(".task-section--related li")).to_have_count(2)  # Related is a plain list of notes, not chips
    expect(page.locator(".task-section--verified")).to_contain_text("Checked by hand.")
    expect(page.locator(".task-step")).to_have_count(2)  # a numbered Plan is drawn as steps
    expect(page.locator(".task-step-name")).to_have_text(["Reproduce", "Fix the cookie"])
    expect(page.locator(".task-step-text").first).to_have_text("Use Safari 17.")
    key = page.locator(".task-section--plan .hljs-attr").first
    expect(key).to_have_text("cookie:")  # code blocks are highlighted here too...
    assert key.evaluate("(el) => getComputedStyle(el).color") != key.evaluate("(el) => getComputedStyle(el.closest('code')).color")  # ...in colour, not just marked up
    expect(page.locator(".spec-outline a[href='#task-s1'] .spec-count")).to_have_text("2")  # steps are counted in the outline
    expect(page.locator(".spec-outline a[href='#task-s2']")).to_have_text("Verification")
    expect(page.locator(".spec-outline a[href='#task-s3'] .spec-count")).to_have_text("2")  # open questions are counted in the outline
    page.click("#note-chat-btn")  # the chat docks beside the workspace and the page makes room for it
    expect(page.locator("task-note-app")).to_have_class(re.compile("chat-docked"))
    pane, dock, header = (page.locator(s).bounding_box() for s in (".spec-workspace", ".notes-chat-dock", "app-header"))
    assert pane["x"] + pane["width"] <= dock["x"] + 1
    expect(page.locator(".spec-outline")).to_be_hidden()  # the sections list steps aside while the chat is open
    assert abs(dock["y"] - (header["y"] + header["height"])) < 2  # the dock starts under the header, in the body only, as on the note page
    assert header["x"] + header["width"] >= dock["x"] + dock["width"] - 1  # and the header runs over it, full width
    page.keyboard.press("Control+Shift+L")
    expect(page.locator("task-note-app")).not_to_have_class(re.compile("chat-docked"))
    expect(page.locator(".spec-outline")).to_be_visible()  # and comes back when it is closed
    page.click("#log-time-btn")  # a task takes time: the dialog and the footer chip work here too
    expect(page.locator(".log-time-title")).to_have_text("Fix login")
    page.keyboard.press("Escape")
    page.click("#edit-note-btn")
    page.wait_for_url("**/notes/fix-login?mode=edit")
    assert page.errors == []


# --- Chat beside a note --------------------------------------------------------------------------------------------------

def open_note_chat(page, chat_server, slug="alpha"):
    page.goto(f"{chat_server.url}/notes/{slug}")
    expect(page.locator("#notes-md")).to_be_visible()
    expect(page.locator(".notes-chat-dock")).to_have_count(0)  # closed until asked for
    page.locator("#note-chat-btn").click()
    expect(page.locator(".notes-chat-dock chat-app[compact]")).to_be_visible()


def test_the_note_chat_sits_beside_the_note_and_edits_show_in_it_live(page, chat_server):
    open_note_chat(page, chat_server)
    note, dock = page.locator("#notes-preview").bounding_box(), page.locator(".notes-chat-dock").bounding_box()
    assert note["x"] + note["width"] <= dock["x"] + 1  # beside it, not over it
    bar, foot = page.locator(".notes-action-bar").bounding_box(), page.locator(".chat-dock-foot").bounding_box()
    assert bar["x"] + bar["width"] <= dock["x"] + 1  # the footer bar stops at the dock...
    assert abs(foot["y"] - bar["y"]) < 1.5 and abs(foot["x"] - dock["x"]) < 2 and foot["x"] + foot["width"] >= dock["x"] + dock["width"] - 1  # ...and the composer is the strip beside it, edge to edge
    expect(page.locator(".notes-footer-actions")).to_be_hidden()
    expect(page.locator("#note-chat-btn")).to_be_hidden()
    expect(page.locator(".chat-dock-title")).to_have_text("Chat")
    page.locator("#chat-input").fill("polish this note")
    page.locator("#chat-send").click()
    expect(page.locator("#notes-md")).to_contain_text("Polished.")  # the note redrew in place under the running chat
    answer = page.locator(".chat-message.assistant .chat-answer")
    expect(answer).to_contain_text("Alpha links to")  # and the redraw did not cut the run
    expect(answer).to_have_css("background-color", "rgba(0, 0, 0, 0)")  # the reply sits on the panel, not on a block of its own
    expect(page.locator(".chat-message.assistant .chat-stopped")).to_have_count(0)
    prompt = chat_server.runner.prompts[-1]
    assert "`alpha.md`" in prompt and prompt.endswith("polish this note")
    page.locator(".chat-changed-history").click()  # the changed note is this one: review or undo it from its history
    expect(page.get_by_role("heading", name="History")).to_be_visible()
    assert page.errors == []


def test_the_note_chat_is_remembered_per_note_and_stays_open(page, chat_server):
    open_note_chat(page, chat_server)
    page.locator("#chat-input").fill("what is this")
    page.locator("#chat-input").press("Enter")
    expect(page.locator(".chat-message.assistant .chat-answer")).to_have_count(1)
    page.reload()
    expect(page.locator(".notes-chat-dock chat-app")).to_be_visible()  # the panel stays open
    expect(page.locator(".chat-message")).to_have_count(2)  # with this note's conversation
    page.goto(f"{chat_server.url}/notes/beta")
    expect(page.locator(".notes-chat-dock chat-app")).to_be_visible()
    expect(page.locator(".chat-message")).to_have_count(0)  # another note, another chat
    expect(page.locator(".chat-dock-title")).to_have_text("Chat")
    page.locator("#chat-close").click()
    expect(page.locator(".notes-chat-dock")).to_be_hidden()
    expect(page.locator(".notes-footer-actions")).to_be_visible()
    expect(page.locator("#note-chat-btn")).to_be_visible()
    expect(page.locator("#note-chat-btn")).to_have_attribute("aria-pressed", "false")
    page.keyboard.press("Control+Shift+L")  # the shortcut opens it again
    expect(page.locator(".notes-chat-dock")).to_be_visible()
    expect(page.locator(".notes-footer-actions")).to_be_hidden()


def test_the_note_chat_saves_unsaved_text_first_and_sends_the_selection(page, chat_server):
    page.goto(f"{chat_server.url}/notes/alpha")
    expect(page.locator("#notes-md")).to_be_visible()
    page.locator("#edit-note-btn").click()
    page.locator("#note-chat-btn").click()
    expect(page.locator(".notes-chat-dock chat-app[compact]")).to_be_visible()
    expect(page.locator(".notes-footer-actions")).to_be_hidden()
    editor = page.locator(".cm-content")
    editor.click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\nTyped before asking.")
    expect(page.locator("#save-note-btn")).not_to_be_disabled()
    expect(page.locator("#notes-md")).to_contain_text("Typed before asking.")  # the preview has redrawn: a selection made earlier would be lost
    page.locator("#notes-md p", has_text="Typed before asking.").click(click_count=3)  # select a paragraph of the preview
    expect(page.locator("#chat-context")).to_be_visible()
    expect(page.locator("#chat-context-text")).to_contain_text("Typed before asking.")
    page.locator("#chat-input").fill("what did I type")
    page.locator("#chat-send").click()
    expect(page.locator(".chat-message.assistant .chat-answer")).to_contain_text("Alpha links to")
    assert "Typed before asking." in (chat_server.root / "alpha.md").read_text()  # saved before the agent was asked
    assert "<<<\nTyped before asking." in chat_server.runner.prompts[-1]  # the selection is quoted before the question
    expect(page.locator("#chat-context")).to_be_hidden()  # the selection belonged to that question
    quote = page.locator(".chat-message.user .chat-user-quote")
    expect(quote).to_contain_text("Typed before asking.")  # the history shows what was quoted with the question
    page.reload()
    expect(page.locator(".chat-message.user .chat-user-quote")).to_contain_text("Typed before asking.")  # and keeps it


def test_the_note_chat_follows_a_rename_and_keeps_its_conversation(page, chat_server):
    open_note_chat(page, chat_server)
    page.locator("#chat-input").fill("retitle this")
    page.locator("#chat-send").click()
    expect(page).to_have_url(f"{chat_server.url}/notes/alpha-two")  # the page follows the new file name once the run is over
    expect(page.locator(".chat-dock-title")).to_have_text("Chat")
    expect(page.locator(".chat-message")).to_have_count(2)  # the conversation came along
    expect(page.locator(".chat-message.assistant .chat-answer")).to_contain_text("Alpha links to")
    assert page.errors == []


# --- Live refresh and chat on the pages of table and timeline notes ------------------------------------------------------------

def seed_read_notes(root):
    (root / "inventory.md").write_text(
        "---\ntitle: Inventory\ntype: table\nupdated: 2026-03-03\n---\n\n# Inventory\n\n"
        "| Employee | Make |\n| --- | --- |\n| Ann Lee | Lenovo |\n| Bo Kim | HP |\n")
    (root / "roadmap.md").write_text(
        "---\ntitle: Roadmap\ntype: timeline\nupdated: 2026-03-03\n---\n\n# Roadmap\n\n"
        "## July 2025 — Kickoff\n\nAligned scope.\n\n- Wrote requirements.\n\n"
        "## August 2025 — Build\n\nBuilt it.\n\n- Shipped ANPN-1.\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "read notes")


def test_a_table_page_follows_outside_changes_and_keeps_its_filter(page, chat_server):
    seed_read_notes(chat_server.root)
    page.goto(f"{chat_server.url}/tables/inventory")
    rows = page.locator("app-table tbody tr")
    expect(rows).to_have_count(2)
    page.locator(".notes-table-filter").fill("HP")
    expect(rows).to_have_count(1)
    path = chat_server.root / "inventory.md"
    path.write_text(path.read_text() + "| Cy Doe | HP |\n")  # an editor, or git pull, changes the file
    git(chat_server.root, "add", "-A")
    git(chat_server.root, "commit", "-qm", "outside edit")
    expect(rows).to_have_count(2)  # the new row is there without a reload...
    expect(page.locator(".notes-table-filter")).to_have_value("HP")  # ...and the filter was kept
    expect(rows.filter(has_text="Cy Doe")).to_have_count(1)
    assert page.errors == []


def test_a_table_page_waits_for_the_row_being_edited_before_showing_a_change(page, chat_server):
    seed_read_notes(chat_server.root)
    page.goto(f"{chat_server.url}/tables/inventory")
    page.locator("app-table tbody tr", has_text="Ann Lee").click()
    drawer = page.locator("app-dialog:not(.is-hidden)")
    expect(drawer).to_be_visible()
    path = chat_server.root / "inventory.md"
    path.write_text(path.read_text() + "| Cy Doe | HP |\n")
    git(chat_server.root, "add", "-A")
    git(chat_server.root, "commit", "-qm", "outside edit")
    expect(page.locator("toast-region, .toast, [role=status]").filter(has_text="changed elsewhere").first).to_be_visible()  # said, not redrawn
    expect(drawer).to_be_visible()  # the open row is not thrown away
    expect(page.locator("app-table tbody tr")).to_have_count(2)
    drawer.locator("[data-dialog-close]").first.click()
    expect(page.locator("app-table tbody tr")).to_have_count(3)  # drawn once the row is closed
    assert page.errors == []


def test_the_table_chat_sits_beside_the_page_and_a_row_it_adds_shows_live(page, chat_server):
    seed_read_notes(chat_server.root)
    page.goto(f"{chat_server.url}/tables/inventory")
    expect(page.locator("app-table tbody tr")).to_have_count(2)
    expect(page.locator(".notes-chat-dock")).to_have_count(0)  # closed until asked for
    page.locator("#note-chat-btn").click()
    dock = page.locator(".notes-chat-dock chat-app[compact]")
    expect(dock).to_be_visible()
    expect(page.locator(".notes-footer-actions")).to_be_hidden()
    box, bar = page.locator(".notes-chat-dock").bounding_box(), page.locator(".notes-action-bar").bounding_box()
    assert bar["x"] + bar["width"] <= box["x"] + 1  # the footer bar stops at the dock
    assert page.locator(".notes-table-card").bounding_box()["x"] + page.locator(".notes-table-card").bounding_box()["width"] <= box["x"] + 1  # the page made room
    page.locator("#chat-input").fill("addrow please")
    page.locator("#chat-send").click()
    expect(page.locator("app-table tbody tr", has_text="Cy Doe")).to_have_count(1)  # the table redrew under the running chat
    expect(page.locator(".chat-message.assistant .chat-answer")).to_contain_text("Alpha links to")
    expect(page.locator(".chat-message.assistant .chat-stopped")).to_have_count(0)  # and the redraw did not cut the run
    expect(page.locator(".chat-changed-history")).to_be_visible()
    assert "`inventory.md`" in chat_server.runner.prompts[-1]
    page.reload()
    expect(page.locator(".notes-chat-dock chat-app")).to_be_visible()  # open stays open...
    expect(page.locator(".chat-message")).to_have_count(2)  # ...with this note's conversation
    page.keyboard.press("Control+Shift+L")
    expect(page.locator(".notes-chat-dock")).to_be_hidden()
    expect(page.locator(".notes-footer-actions")).to_be_visible()
    assert page.errors == []


def test_the_timeline_chat_works_and_its_phases_follow_the_note(page, chat_server):
    seed_read_notes(chat_server.root)
    page.goto(f"{chat_server.url}/timelines/roadmap")
    expect(page.locator(".timeline-phase")).to_have_count(2)
    page.locator("#note-chat-btn").click()
    expect(page.locator(".notes-chat-dock chat-app[compact]")).to_be_visible()
    expect(page.locator(".notes-footer-actions")).to_be_hidden()
    page.locator(".timeline-phase-title").first.click(click_count=3)  # the selection goes with the next question
    expect(page.locator("#chat-context-text")).to_contain_text("Kickoff")
    page.locator("#chat-input").fill("addphase please")
    page.locator("#chat-send").click()
    expect(page.locator(".timeline-phase")).to_have_count(3)
    expect(page.locator(".chat-message.assistant .chat-answer")).to_contain_text("Alpha links to")
    prompt = chat_server.runner.prompts[-1]
    assert "`roadmap.md`" in prompt and "<<<\nKickoff" in prompt
    page.locator("#chat-close").click()
    expect(page.locator(".notes-chat-dock")).to_be_hidden()
    expect(page.locator(".notes-footer-actions")).to_be_visible()
    assert page.errors == []


# --- Library (IPTV): copy the stream URL ------------------------------------------------------------------------------

@pytest.fixture
def library_server(notes_dir, tmp_path):
    from src.application.iptv.catalog import IptvCatalog
    from src.infrastructure.iptv.store import IptvStore
    from tests.iptv_fake import client as fake_client

    catalog = IptvCatalog(IptvStore(tmp_path / "iptv.db"), lambda: fake_client())
    catalog.start_sync()
    catalog.wait(10)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir, watch=False, iptv=catalog), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


def library_page(server):
    p = sync_playwright().start()
    try:
        browser = p.chromium.launch()
    except Exception as exc:
        p.stop()
        pytest.skip(f"chromium unavailable: {exc}")
    context = browser.new_context(viewport={"width": 1400, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    return p, browser, context.new_page()


def test_copy_icon_copies_the_stream_url_and_a_toast_says_so(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv?type=vod")
        card = page.locator(".iptv-card", has_text="Heat")
        expect(card.locator(".iptv-copy")).to_have_css("opacity", "0")  # shown only on hover
        card.hover()
        expect(card.locator(".iptv-copy")).to_have_css("opacity", "1")
        card.locator(".iptv-copy").click()
        expect(page.locator(".app-toast")).to_have_text("Stream URL copied. Open in VLC Network Stream.")
        expect(page.locator(".app-toast")).to_be_visible()
        assert page.evaluate("navigator.clipboard.readText()") == "http://prov.example:8080/movie/alice/s3cret%2Fpw/20.mkv"
        expect(card.locator(".iptv-copy i")).to_have_class("fa-solid fa-check")
    finally:
        browser.close()
        p.stop()


def test_a_series_card_opens_a_drawer_with_facts_seasons_and_episodes_to_copy(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv?type=series")
        page.locator(".iptv-card", has_text="The Wire").click()
        drawer = page.locator(".iptv-series-drawer")
        expect(drawer.locator(".modal-title")).to_have_text("The Wire")
        expect(drawer.locator(".iptv-plot")).to_have_text("Baltimore, told from every side.")
        expect(drawer.locator(".iptv-facts")).to_have_text("2002★ 9.3")
        expect(drawer.locator(".iptv-trailer")).to_have_attribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        assert page.url.endswith("/iptv?type=series")  # no page change: the list stays behind the drawer
        expect(drawer.locator(".iptv-seasons .tab-bar-item")).to_have_text(["The Buy", "Season 2"])
        episodes = drawer.locator(".iptv-episode")
        expect(episodes).to_have_count(2)
        expect(episodes.nth(1)).to_contain_text("E02 · Two")
        expect(episodes.nth(1)).to_contain_text("50m")
        expect(episodes.nth(1)).to_contain_text("The second.")
        drawer.locator(".iptv-seasons .tab-bar-item", has_text="Season 2").click()
        expect(episodes).to_have_count(1)
        drawer.locator(".iptv-seasons .tab-bar-item", has_text="The Buy").click()
        episodes.nth(1).locator(".iptv-episode-copy").click()
        expect(page.locator(".app-toast")).to_have_text("Stream URL copied. Open in VLC Network Stream.")
        assert page.evaluate("navigator.clipboard.readText()") == "http://prov.example:8080/series/alice/s3cret%2Fpw/301.mp4"
        box = page.locator(".app-toast").bounding_box()
        assert page.evaluate("([x, y]) => document.elementFromPoint(x, y)?.closest('.app-toast') !== null", [box["x"] + 10, box["y"] + box["height"] / 2]), "the toast is behind the drawer"
        page.screenshot(path="/tmp/claude-501/-home-ramesh-Workspace-hive/87a59954-02fa-4dce-8d54-5dc9484ad38a/scratchpad/drawer.png")
        page.keyboard.press("Escape")
        expect(drawer).to_have_count(0)
        expect(page.locator(".iptv-card", has_text="The Wire")).to_be_visible()
    finally:
        browser.close()
        p.stop()


def test_a_long_episode_list_scrolls_in_the_drawer_and_leaves_the_season_tabs_whole(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv?type=series")
        page.locator(".iptv-card", has_text="Long Show").click()
        drawer = page.locator(".iptv-series-drawer")
        expect(drawer.locator(".iptv-episode")).to_have_count(20)
        expect(drawer.locator(".iptv-seasons .tab-bar-item")).to_have_text(["Season 1"])
        assert drawer.locator(".iptv-seasons").bounding_box()["height"] >= 30  # not squashed by the list below it
        assert drawer.locator(".iptv-drawer-body").evaluate("e => e.scrollHeight > e.clientHeight")  # the list scrolls instead
        expect(drawer.locator(".iptv-episode-title").first).to_have_text("E01")  # the playlist junk is gone
        expect(drawer.locator(".iptv-episode-title").nth(11)).to_have_text("E12")
    finally:
        browser.close()
        p.stop()


def test_library_search_is_the_autocomplete_and_slash_focuses_it(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv")
        field = page.locator("#iptv-search-input")
        expect(field).to_have_attribute("placeholder", "Search movies…")
        page.keyboard.press("/")
        expect(field).to_be_focused()
        field.fill("heat")
        expect(page.locator(".iptv-card")).to_have_count(1)
        expect(page.locator(".iptv-card")).to_contain_text("Heat")
    finally:
        browser.close()
        p.stop()


@pytest.mark.parametrize("kind", ["vod", "series", "live"])
def test_iptv_autocompletes_starred_search(library_server, kind):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv?type={kind}")
        cards = page.locator(".iptv-card")
        cards.first.locator("[data-star]").click()
        expect(cards.first.locator("[data-star]")).to_have_attribute("aria-pressed", "true")

        field = page.locator("#iptv-search-input")
        field.fill("is:")
        option = page.get_by_role("option", name="is:starred", exact=False)
        expect(option).to_be_visible()
        expect(option).to_be_in_viewport()
        field.press("ArrowDown")
        field.press("Enter")
        expect(field).to_have_value("is:starred ")
        expect(option).to_be_hidden()
        expect(cards).to_have_count(1)
        expect(cards.first.locator("[data-star]")).to_have_attribute("aria-pressed", "true")
    finally:
        browser.close()
        p.stop()


def test_iptv_group_autocomplete_shows_operator_and_accepts_keyboard_selection(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv")
        field = page.locator("#iptv-search-input")
        field.fill("ronin ac")
        option = page.get_by_role("option", name="group:Action", exact=False)
        expect(option).to_be_visible()
        field.press("ArrowDown")
        field.press("Enter")
        expect(field).to_have_value("ronin group:Action ")
        cards = page.locator(".iptv-card")
        expect(cards).to_have_count(1)
        expect(cards.first).to_contain_text("Ronin")
    finally:
        browser.close()
        p.stop()


def test_typing_group_suggests_categories_and_picking_one_filters(library_server):
    p, browser, page = library_page(library_server)
    try:
        page.goto(f"{library_server}/iptv")
        expect(page.locator(".iptv-card")).to_have_count(2)
        field = page.locator("#iptv-search-input")
        field.click()
        field.type("group:ac")
        option = page.locator(".autocomplete-option")
        expect(option).to_have_count(1)
        expect(option).to_contain_text("Action")
        option.click()
        expect(field).to_have_value("group:Action ")
        expect(page.locator(".iptv-card")).to_have_count(2)
        field.type("ronin")
        expect(page.locator(".iptv-card")).to_have_count(1)
        page.locator(".autocomplete-help-btn").click()
        expect(page.locator(".autocomplete-help-panel")).to_contain_text("group:")
        page.screenshot(path="/tmp/claude-501/-home-ramesh-Workspace-hive/87a59954-02fa-4dce-8d54-5dc9484ad38a/scratchpad/library.png")
    finally:
        browser.close()
        p.stop()


@pytest.fixture
def big_library_server(notes_dir, tmp_path):
    from src.application.iptv.catalog import IptvCatalog
    from src.domain.iptv.entities import Channel, StreamType
    from src.infrastructure.iptv.store import IptvStore
    from tests.iptv_fake import client as fake_client

    store = IptvStore(tmp_path / "iptv.db")
    store.replace(StreamType.VOD, [Channel(str(i), StreamType.VOD, f"Movie {i:03d}", "G", added=1000 + i) for i in range(130)], "t")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(notes_dir, watch=False, iptv=IptvCatalog(store, lambda: fake_client())), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


def test_library_loads_more_cards_as_the_page_is_scrolled(big_library_server):
    p, browser, page = library_page(big_library_server)
    try:
        page.goto(f"{big_library_server}/iptv")
        cards = page.locator(".iptv-card")
        expect(cards).not_to_have_count(0)
        assert page.locator("app-pagination").count() == 0  # no page buttons
        first = cards.count()
        assert 48 <= first < 130  # one page (a tall window may have asked for the next already)
        assert "Movie 129" in cards.first.inner_text()  # newest first
        for _ in range(10):  # scroll to the end of what is loaded until everything is there
            page.mouse.wheel(0, 20000)
            page.evaluate("document.querySelector('.iptv-more').scrollIntoView()")
            if cards.count() == 130:
                break
            page.wait_for_timeout(300)
        expect(cards).to_have_count(130)
        page.evaluate("document.querySelector('.iptv-more').scrollIntoView()")
        page.wait_for_timeout(500)
        expect(cards).to_have_count(130)  # the end: nothing more is asked for
        # a search starts the list again
        page.locator("#iptv-search-input").fill("movie 129")
        expect(cards).to_have_count(1)
    finally:
        browser.close()
        p.stop()


@pytest.mark.parametrize(
    ("types", "route", "outline", "can_log_time"),
    [
        ("meeting-minutes", "meeting-minutes", "Meeting minutes sections", False),
        ("[meeting, meeting-minutes]", "meeting-minutes", "Meeting minutes sections", True),
        ("meeting", "meetings", "Meeting sections", True),
    ],
)
def test_meeting_minutes_open_as_sections_with_an_outline_and_the_pencil_opens_the_editor(
    page, server, notes_dir, types, route, outline, can_log_time
):
    (notes_dir / "kickoff.md").write_text(
        f"---\ntitle: Kickoff\ntype: {types}\ndate: 2026-11-25\nproject: Alpha\n---\n\n"
        "# Kickoff\n\nTeam kickoff.\n\n## Attendees\n\n- Mira\n\n"
        "## Decisions\n\n- Ship on Friday.\n\n## Action Items\n\n- [ ] Mira to notify [[Alpha]].\n"
    )
    git(notes_dir, "add", "kickoff.md")
    git(notes_dir, "commit", "-qm", "meeting minutes")

    page.goto(f"{server}/notes/kickoff")
    page.wait_for_url(f"**/{route}/kickoff")
    expect(page.locator("app-header")).to_have_attribute("heading", "Kickoff")
    shell = page.locator("app-shell .page-main").bounding_box()
    minutes = page.locator("meeting-minutes-app").bounding_box()
    assert minutes["x"] == pytest.approx(shell["x"], abs=1)
    assert minutes["y"] == pytest.approx(shell["y"], abs=1)
    assert minutes["width"] == pytest.approx(shell["width"], abs=1)
    assert minutes["height"] >= shell["height"] - 1
    expect(page.locator("app-header [title='Meeting date']")).to_have_text("2026-11-25")
    expect(page.get_by_role("navigation", name=outline).get_by_role("link")).to_have_text(
        ["Summary", "Attendees", "Decisions", "Action Items 0/1"]
    )
    expect(page.locator(".minutes-section--decisions")).to_contain_text("Ship on Friday.")
    expect(page.locator(".minutes-section--decisions")).to_have_css("border-inline-start-width", "2px")
    expect(page.locator(".minutes-section--actions")).to_have_css("border-inline-start-width", "1px")
    expect(page.locator(".minutes-section--actions input[type=checkbox]")).to_be_enabled()
    expect(page.locator(".minutes-section--actions .notes-wikilink")).to_have_text("Alpha")
    expect(page.locator("#log-time-btn")).to_have_count(int(can_log_time))
    page.click("#edit-note-btn")
    page.wait_for_url("**/notes/kickoff?mode=edit")


def test_short_meeting_minutes_use_the_outline_space_for_content(page, server, notes_dir):
    (notes_dir / "short-minutes.md").write_text(
        "---\ntitle: Short minutes\ntype: meeting-minutes\n---\n\n"
        "# Short minutes\n\nA brief summary.\n\n"
        "## Key Decision Points\n\n- **Release:** Ship on Friday.\n\n## Action Items\n\n- [ ] **Send** the update —\n  Mira Patel\n- Verify the rollout.\n"
    )
    page.goto(f"{server}/meeting-minutes/short-minutes")
    expect(page.locator(".minutes-section")).to_have_count(3)
    expect(page.locator(".minutes-workspace .spec-outline")).to_have_count(0)
    decision = page.locator(".minutes-section--decision-points strong")
    expect(decision).to_have_text("Release:")
    assert decision.evaluate("""(el) => {
        const actual = getComputedStyle(el).color;
        el.style.color = 'var(--color-yellow)';
        const yellow = getComputedStyle(el).color;
        el.style.removeProperty('color');
        return actual === yellow && actual !== getComputedStyle(el.parentElement).color;
    }""")
    assert page.locator(".minutes-section--actions strong").evaluate(
        "(el) => getComputedStyle(el).color === getComputedStyle(el.parentElement).color"
    )
    owner = page.locator(".minutes-action-owner")
    expect(owner).to_have_text("Mira Patel")
    expect(owner).to_have_css("font-style", "italic")
    assert owner.evaluate("""(el) => {
        const color = getComputedStyle(el).color;
        el.style.color = 'var(--color-blue)';
        return color === getComputedStyle(el).color;
    }""")
    bullet = page.locator(".minutes-section--actions li").last
    assert bullet.evaluate("""(el) => {
        const marker = getComputedStyle(el, '::marker').color;
        el.style.color = 'var(--color-red)';
        return marker === getComputedStyle(el).color;
    }""")
    workspace = page.locator(".minutes-workspace")
    assert workspace.evaluate("""(el) => {
        const style = getComputedStyle(el);
        const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return Math.abs(el.querySelector('.spec-main').getBoundingClientRect().width - available) <= 1;
    }""")


def test_meeting_breadcrumbs_link_project_and_series(page, server, notes_dir):
    (notes_dir / "alpha-platform.md").write_text("---\ntitle: Alpha Platform\n---\n# Alpha Platform\n")
    (notes_dir / "kickoff.md").write_text(
        "---\ntitle: Kickoff\ntype: meeting\nproject: '[[alpha-platform]]'\n---\n# Kickoff\n"
    )
    (notes_dir / "kickoff-minutes.md").write_text(
        "---\ntitle: Kickoff Minutes\ntype: meeting-minutes\nproject: Alpha Platform\nseries: Kickoff\n---\n# Kickoff Minutes\n"
    )

    page.goto(f"{server}/meeting-minutes/kickoff-minutes")
    trail = page.get_by_role("navigation", name="Breadcrumb")
    expect(trail.get_by_role("link")).to_have_text(["Alpha Platform", "Kickoff"])
    expect(trail.locator('[aria-current="page"]')).to_have_text("Kickoff Minutes")
    heading = page.get_by_role("heading", name="Kickoff Minutes")
    assert trail.bounding_box()["y"] < heading.bounding_box()["y"]
    header_box = page.locator("app-header").bounding_box()
    heading_box = heading.bounding_box()
    assert trail.bounding_box()["y"] - header_box["y"] >= 4
    assert header_box["height"] == pytest.approx(106, abs=1)
    assert heading.evaluate("""(heading) => {
        const header = heading.getRootNode().host;
        const before = heading.getBoundingClientRect().top;
        const crumbs = header.breadcrumbs;
        header.breadcrumbs = [];
        const withoutTrail = heading.getBoundingClientRect().top;
        header.breadcrumbs = crumbs;
        return before === withoutTrail;
    }""")
    trail.get_by_role("link", name="Kickoff").click()

    page.wait_for_url("**/meetings/kickoff")
    expect(trail.get_by_role("link", name="Alpha Platform")).to_have_attribute("href", "/notes/alpha-platform")
    expect(trail.locator('[aria-current="page"]')).to_have_text("Kickoff")
    trail.get_by_role("link", name="Alpha Platform").click()
    page.wait_for_url("**/notes/alpha-platform")


def test_meeting_series_shows_latest_minutes_and_participants(page, server, notes_dir):
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\nRecurring project sync.\n\n"
        "## Participants\n- [[Mira]] <mira@example.com>\n\n"
        "## Minutes\n- [[Weekly Minutes — June 3, 2026]]\n- [[Weekly Minutes — November 18, 2026]]\n"
        "- [[Weekly Minutes — July 8, 2026]]\n"
    )
    (notes_dir / "mira.md").write_text("# Mira\n")
    (notes_dir / "november-minutes.md").write_text(
        "---\ntitle: 'Weekly Minutes — November 18, 2026'\ntype: meeting_minutes\n---\n"
        "# Weekly Minutes — November 18, 2026\n\n## Key Decision Points\nShip on Friday.\n\n"
        "## Action Items\n- [x] Confirm date.\n- [ ] Send invite.\n"
    )

    page.goto(f"{server}/notes/weekly")
    page.wait_for_url("**/meetings/weekly")
    participants = page.get_by_role("complementary", name="Participants")
    expect(participants.get_by_role("link", name="Mira")).to_have_attribute("data-slug", "mira")
    expect(participants.get_by_text("mira@example.com")).to_have_count(0)
    summary = page.locator("#minutes-summary").bounding_box()
    minutes, people = page.locator(".minutes-archive").bounding_box(), participants.bounding_box()
    assert summary["y"] + summary["height"] <= minutes["y"] and summary["width"] > minutes["width"] + people["width"]
    assert people["x"] > minutes["x"] + minutes["width"] and abs(people["y"] - minutes["y"]) < 40
    expect(page.locator(".minutes-archive .minutes-list-title")).to_have_text(
        ["Wednesday, November 18, 2026", "Wednesday, July 8, 2026", "Wednesday, June 3, 2026"]
    )
    expect(page.locator(".minutes-archive .minutes-list-ago").first).not_to_be_empty()
    expect(page.locator(".minutes-list-subtitle")).to_have_count(0)  # "Weekly" is the series name on every row
    expect(page.locator("#log-time-btn")).to_be_visible()
    page.get_by_role("link", name="Wednesday, November 18, 2026").click()
    page.wait_for_url("**/meeting-minutes/november-minutes")
    expect(page.get_by_role("navigation", name="Meeting highlights")).to_have_count(0)
    page.get_by_role("navigation", name="Breadcrumb").get_by_role("link", name="Weekly").click()
    page.wait_for_url("**/meetings/weekly")


def test_meeting_summary_top_wikilinks_resolve_and_navigate(page, server, notes_dir):
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\nSync for [[Alpha]].\n\n"
        "## Participants\n- [[Mira]]\n"
    )
    (notes_dir / "alpha.md").write_text("# Alpha\n")
    (notes_dir / "mira.md").write_text("# Mira\n")

    page.goto(f"{server}/meetings/weekly")
    top_link = page.locator(".minutes-top").get_by_role("link", name="Alpha")
    expect(top_link).to_have_attribute("data-slug", "alpha")
    top_link.click()
    page.wait_for_url("**/notes/alpha")


def test_spotlight_navigates_directly_to_read_page_and_read_page_creates_missing_wikilink(page, server, notes_dir):
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\nFollow up with [[Missing Person]].\n"
    )
    (notes_dir / "home.md").write_text("# Home\n\nJust a regular note.\n")

    page.goto(f"{server}/notes/home")
    page.get_by_role("button", name="Search notes").click()
    spotlight = page.locator("note-spotlight")
    spotlight.locator(".spotlight-input").fill("Weekly")
    spotlight.locator(".spotlight-item", has_text="Weekly").click()
    page.wait_for_url("**/meetings/weekly")

    broken = page.locator(".minutes-workspace").get_by_role("link", name="Missing Person")
    expect(broken).to_have_class(re.compile(r"\bunresolved\b"))
    broken.click()
    dialog = page.locator("app-dialog")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Create Note").click()
    page.wait_for_url("**/notes/missing-person?mode=edit")


def test_meeting_minutes_breadcrumbs_stay_cached_when_ticking_action(page, server, notes_dir):
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\n## Minutes\n- [[Weekly — Nov 18]]\n"
    )
    (notes_dir / "weekly-nov-18.md").write_text(
        "---\ntitle: 'Weekly — Nov 18'\ntype: meeting_minutes\n---\n"
        "# Weekly — Nov 18\n\n## Action Items\n- [ ] Send notes.\n"
    )

    page.goto(f"{server}/meeting-minutes/weekly-nov-18")
    crumb = page.get_by_role("navigation", name="Breadcrumb").get_by_role("link", name="Weekly")
    expect(crumb).to_be_visible()

    backlinks_calls = 0
    def count_backlinks(route):
        nonlocal backlinks_calls
        backlinks_calls += 1
        route.continue_()

    page.route("**/api/notes/*/backlinks", count_backlinks)
    page.get_by_role("checkbox", name="Done").click()
    expect(page.get_by_role("checkbox", name="Done")).to_be_checked()
    expect(crumb).to_be_visible()
    assert backlinks_calls == 0


def test_meeting_minutes_show_header_chips_action_meter_and_avatars(page, server, notes_dir):
    (notes_dir / "sync-minutes.md").write_text(
        "---\ntitle: Sync minutes\ntype: meeting_minutes\ndate: 2026-11-25\nproject: Alpha\n---\n"
        "# Sync minutes\n\nShort recap.\n\n## Action Items\n- [x] Done thing.\n- [ ] Open thing — Mira Patel\n"
    )
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\n## Participants\n- [[Mira]]\n- [[Noor]]\n"
    )
    page.goto(f"{server}/meeting-minutes/sync-minutes")
    expect(page.locator("app-header [title='Action items']")).to_have_text("1/2 actions done")
    expect(page.get_by_role("img", name="1 of 2 actions done")).to_be_visible()
    expect(page.locator(".minutes-action-owner")).to_have_text("Mira Patel")
    page.goto(f"{server}/meetings/weekly")
    expect(page.locator(".minutes-avatar")).to_have_text(["M", "N"])


def test_action_items_can_be_ticked_and_items_without_a_box_start_as_not_done(page, server, notes_dir):
    (notes_dir / "sync-minutes.md").write_text(
        "---\ntitle: Sync minutes\ntype: meeting_minutes\n---\n# Sync minutes\n\n## Decisions\n- [ ] Not an action.\n\n"
        "## Action Items\n- [ ] Send invite\n- Verify the rollout\n- [x] Book room\n"
    )
    git(notes_dir, "add", "sync-minutes.md")
    git(notes_dir, "commit", "-qm", "minutes")
    page.goto(f"{server}/meeting-minutes/sync-minutes")
    boxes = page.locator(".minutes-section--actions input[type=checkbox]")
    expect(boxes).to_have_count(3)
    expect(boxes.nth(1)).not_to_be_checked()
    expect(page.locator("app-header [title='Action items']")).to_have_text("1/3 actions done")

    boxes.nth(1).check()
    expect(page.locator("app-header [title='Action items']")).to_have_text("2/3 actions done")
    boxes.nth(0).check()
    expect(page.locator("app-header [title='Action items']")).to_have_text("3/3 actions done")
    expect(boxes.nth(1)).to_be_checked()
    text = (notes_dir / "sync-minutes.md").read_text()
    assert "- [x] Send invite\n- [x] Verify the rollout\n- [x] Book room" in text
    assert "- [ ] Not an action." in text

    boxes.nth(2).uncheck()
    expect(page.locator("app-header [title='Action items']")).to_have_text("2/3 actions done")
    assert "- [ ] Book room" in (notes_dir / "sync-minutes.md").read_text()


def test_minutes_breadcrumb_is_the_date_under_its_series_and_the_full_title_otherwise(page, server, notes_dir):
    (notes_dir / "cip-weekly.md").write_text("---\ntitle: CIP Weekly\ntype: meeting\n---\n# CIP Weekly\n")
    (notes_dir / "cip-nov.md").write_text(
        "---\ntitle: 'CIP Minutes — November 18, 2026'\ntype: meeting_minutes\nseries: CIP Weekly\n---\n"
        "# CIP Minutes — November 18, 2026\n"
    )
    (notes_dir / "loose.md").write_text(
        "---\ntitle: 'Loose Minutes — November 18, 2026'\ntype: meeting_minutes\n---\n# Loose Minutes — November 18, 2026\n"
    )
    page.goto(f"{server}/meeting-minutes/cip-nov")
    trail = page.get_by_role("navigation", name="Breadcrumb")
    expect(trail.get_by_role("link")).to_have_text(["CIP Weekly"])
    expect(trail.locator('[aria-current="page"]')).to_have_text("Wednesday, November 18, 2026")
    expect(trail.locator('[aria-current="page"]')).to_have_attribute("title", "CIP Minutes — November 18, 2026")
    expect(page.get_by_role("heading", name="CIP Minutes — November 18, 2026")).to_be_visible()
    page.goto(f"{server}/meeting-minutes/loose")
    expect(page.locator("app-header")).to_have_attribute("heading", "Loose Minutes — November 18, 2026")
    expect(page.get_by_role("navigation", name="Breadcrumb")).to_have_count(0)  # one crumb is only the page itself


def test_a_link_clicked_before_wiki_links_resolve_still_opens_the_read_page_directly(page, server, notes_dir):
    (notes_dir / "weekly.md").write_text(
        "---\ntitle: Weekly\ntype: meeting\n---\n# Weekly\n\n## Minutes\n- [[Weekly Minutes — November 18, 2026]]\n"
    )
    (notes_dir / "weekly-nov.md").write_text(
        "---\ntitle: 'Weekly Minutes — November 18, 2026'\ntype: meeting_minutes\nseries: Weekly\n---\n"
        "# Weekly Minutes — November 18, 2026\n"
    )
    held, visited = [], []
    page.on("request", lambda request: visited.append(request.url) if request.is_navigation_request() else None)
    page.route("**/api/resolve?*", lambda route: held.append(route) if not held else route.continue_())
    page.goto(f"{server}/meetings/weekly")
    expect(page.locator(".minutes-list a")).to_have_attribute("href", "#")  # the page's own lookup is still held back
    page.locator(".minutes-list a").click()
    page.wait_for_url("**/meeting-minutes/weekly-nov")  # straight to the read page, not through /notes/weekly-nov
    assert not any(url.endswith("/notes/weekly-nov") for url in visited)
    trail = page.get_by_role("navigation", name="Breadcrumb")
    expect(trail.get_by_role("link", name="Weekly")).to_have_attribute("href", "/meetings/weekly")
    trail.get_by_role("link", name="Weekly").click()
    page.wait_for_url("**/meetings/weekly")

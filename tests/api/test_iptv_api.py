import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app
from src.application.iptv.catalog import IptvCatalog
from src.domain.iptv.entities import Channel, StreamType
from src.infrastructure.iptv.store import IptvStore
from tests.iptv_fake import client as fake_client


def make_app(tmp_path, configured=True):
    notes = tmp_path / "notes"
    notes.mkdir()
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(notes), *a], check=True, capture_output=True)
    catalog = IptvCatalog(IptvStore(tmp_path / "iptv.db"), (lambda: fake_client()) if configured else (lambda: None))
    return create_app(notes, watch=False, iptv=catalog), catalog


@pytest.fixture
def synced(tmp_path):
    app, catalog = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post("/api/iptv/sync").json() == {"started": True}
        catalog.wait(10)
        yield c


def test_sync_fills_the_catalogue_and_reports_status(synced):
    status = synced.get("/api/iptv/status").json()
    assert status["configured"] and not status["running"] and status["error"] is None and status["synced_at"]
    assert status["counts"] == {"live": 1, "vod": 2, "series": 2}


def test_listings_never_carry_a_stream_url_or_the_account(synced):
    body = synced.get("/api/iptv/channels", params={"type": "vod", "q": "heat"}).json()
    assert [c["name"] for c in body["items"]] == ["Heat"] and body["total"] == 1 and body["total_pages"] == 1
    text = synced.get("/api/iptv/channels", params={"type": "live"}).text
    assert "s3cret" not in text and "alice" not in text and "prov.example" not in text


def test_groups_and_bad_options(synced):
    assert synced.get("/api/iptv/groups", params={"type": "vod"}).json() == [{"name": "Action", "count": 2}]
    for query in ("type=tv", "type=vod&sort=x", "type=vod&page=-1", "type=vod&page_size=101"):
        assert synced.get(f"/api/iptv/channels?{query}").status_code == 422


def test_stream_url_is_given_one_at_a_time_and_not_cached(synced):
    r = synced.get("/api/iptv/stream-url", params={"type": "vod", "id": "20"})
    assert r.json() == {"title": "Heat", "url": "http://prov.example:8080/movie/alice/s3cret%2Fpw/20.mkv"}
    assert r.headers["cache-control"] == "no-store"
    assert synced.get("/api/iptv/stream-url", params={"type": "live", "id": "10"}).json()["url"].endswith("/live/alice/s3cret%2Fpw/10.ts")
    assert synced.get("/api/iptv/play.m3u", params={"type": "vod", "id": "20"}).status_code in (404, 405)  # the playlist route is gone


def test_an_episode_url_uses_its_own_id_and_extension(synced):
    body = synced.get("/api/iptv/series/30").json()
    assert [(s["number"], [e["number"] for e in s["episodes"]]) for s in body["seasons"]] == [(1, [1, 2]), (2, [1])]
    r = synced.get("/api/iptv/stream-url", params={"type": "series", "id": "30", "episode": "301"}).json()
    assert r == {"title": "The Wire S01E02 Two", "url": "http://prov.example:8080/series/alice/s3cret%2Fpw/301.mp4"}
    assert synced.get("/api/iptv/stream-url", params={"type": "series", "id": "30", "episode": "nope"}).status_code == 404
    assert synced.get("/api/iptv/stream-url", params={"type": "series", "id": "30"}).status_code == 404
    assert synced.get("/api/iptv/series/999").status_code == 404


def test_unknown_channel_is_404_and_a_title_stays_on_one_line(synced):
    assert synced.get("/api/iptv/stream-url", params={"type": "vod", "id": "404"}).status_code == 404
    synced.app.state.iptv.store.replace(StreamType.VOD, [Channel("5", StreamType.VOD, "Evil\nTitle", "G", ext="mp4")], "t")
    assert synced.get("/api/iptv/stream-url", params={"type": "vod", "id": "5"}).json()["title"] == "Evil Title"


def test_without_an_account_nothing_is_requested(tmp_path):
    app, _ = make_app(tmp_path, configured=False)
    with TestClient(app) as c:
        assert c.get("/api/iptv/status").json()["configured"] is False
        assert c.post("/api/iptv/sync").status_code == 409
        assert c.get("/api/iptv/stream-url", params={"type": "vod", "id": "1"}).status_code == 404


def test_a_failed_sync_keeps_the_old_catalogue_and_hides_the_password(tmp_path):
    from src.infrastructure.iptv.xtream import XtreamConfig
    app, catalog = make_app(tmp_path)
    with TestClient(app) as c:
        c.post("/api/iptv/sync"); catalog.wait(10)
        catalog._factory = lambda: fake_client(XtreamConfig("http://prov.example:8080", "alice", "wrong"))
        c.post("/api/iptv/sync"); catalog.wait(10)
        status = c.get("/api/iptv/status").json()
        assert "401" in status["error"] and "wrong" not in status["error"] and status["counts"]["vod"] == 2


def test_the_library_page_is_its_own_app_and_iptv_redirects_to_it(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as c:
        page = c.get("/library").text
        assert "iptv-app" in page and 'app="library"' in page
        moved = c.get("/iptv?type=vod", follow_redirects=False)
        assert moved.status_code == 301 and moved.headers["location"] == "/library?type=vod"
    sidebar = open("static/sidebar.js").read()
    assert all(href in sidebar for href in ("'/library'", "'/library?type=series'", "'/library?type=live'"))


def test_static_files_are_revalidated_so_a_fixed_script_is_not_served_from_an_old_cache(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/static/toast.js")
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache" and r.headers["etag"]
        assert c.get("/static/toast.js", headers={"If-None-Match": r.headers["etag"]}).status_code == 304


def test_live_channels_come_with_a_clean_name_quality_and_note_and_the_stored_name_is_unchanged(synced):
    live = synced.get("/api/iptv/channels", params={"type": "live"}).json()["items"][0]
    assert (live["name"], live["display_name"], live["quality"], live["note"]) == ("|UK| BBC One HD", "BBC One", "HD", "")
    vod = synced.get("/api/iptv/channels", params={"type": "vod"}).json()["items"][0]
    assert "display_name" not in vod  # movies and series are tidied by the page


def test_search_filters_by_category_with_group(synced):
    assert [c["name"] for c in synced.get("/api/iptv/channels", params={"type": "vod", "q": "group:action"}).json()["items"]] == ["Heat", "Ronin 100%"]
    assert [c["name"] for c in synced.get("/api/iptv/channels", params={"type": "vod", "q": "ronin group:act"}).json()["items"]] == ["Ronin 100%"]
    assert synced.get("/api/iptv/channels", params={"type": "vod", "q": "group:drama"}).json()["total"] == 0


def test_series_page_data_has_the_facts_seasons_and_episodes_but_no_stream_urls(synced):
    body = synced.get("/api/iptv/series/30").json()
    assert (body["name"], body["group"], body["type"]) == ("The Wire", "Drama", "series")
    assert body["info"]["plot"] == "Baltimore, told from every side." and body["info"]["year"] == 2002 and body["info"]["rating"] == 9.3
    assert [s["name"] for s in body["seasons"]] == ["The Buy", "Season 2"]
    two = body["seasons"][0]["episodes"][1]
    assert two == {"id": "301", "number": 2, "title": "Two", "plot": "The second.", "duration": 3000, "image": "http://img.example/e2.jpg"}
    text = synced.get("/api/iptv/series/30").text
    assert "s3cret" not in text and "alice" not in text and "prov.example" not in text


def _names(c, **params):
    return [x["name"] for x in c.get("/api/iptv/channels", params=params).json()["items"]]


def test_starring_marks_an_item_and_is_found_with_is_starred(synced):
    assert all(not c["starred"] for c in synced.get("/api/iptv/channels", params={"type": "vod"}).json()["items"])
    assert synced.put("/api/iptv/star", params={"type": "vod", "id": "21"}).json() == {"starred": True}
    assert synced.put("/api/iptv/star", params={"type": "series", "id": "30"}).status_code == 200
    assert _names(synced, type="vod", q="is:starred") == ["Ronin 100%"]
    assert _names(synced, type="series", q="is:starred") == ["The Wire"]
    assert _names(synced, type="live", q="is:starred") == []  # stars are per kind
    assert _names(synced, type="vod", q="is:starred heat") == []
    assert _names(synced, type="vod", q="is:starred group:action") == ["Ronin 100%"]
    flags = {c["name"]: c["starred"] for c in synced.get("/api/iptv/channels", params={"type": "vod"}).json()["items"]}
    assert flags == {"Heat": False, "Ronin 100%": True}
    assert synced.get("/api/iptv/series/30").json()["starred"] is True
    assert synced.delete("/api/iptv/star", params={"type": "vod", "id": "21"}).json() == {"starred": False}
    assert _names(synced, type="vod", q="is:starred") == []


def test_stars_survive_a_sync_and_unknown_items_are_404(synced, tmp_path):
    synced.put("/api/iptv/star", params={"type": "vod", "id": "20"})
    assert synced.post("/api/iptv/sync").json() == {"started": True}
    synced.app.state.iptv.wait(10)
    assert _names(synced, type="vod", q="is:starred") == ["Heat"]
    assert synced.put("/api/iptv/star", params={"type": "vod", "id": "999"}).status_code == 404
    assert synced.delete("/api/iptv/star", params={"type": "vod", "id": "999"}).status_code == 404

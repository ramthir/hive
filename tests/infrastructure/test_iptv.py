import pytest

from src.domain.iptv.entities import Channel, StreamType
from src.infrastructure.iptv.store import IptvStore
from src.infrastructure.iptv.xtream import ProviderError, XtreamConfig
from tests.iptv_fake import CONFIG, client


def test_fetch_drops_adult_categories_provider_hosted_logos_and_bad_extensions():
    live = client().fetch(StreamType.LIVE)
    assert [c.id for c in live] == ["10"] and live[0].logo == "http://img.example/bbc.png" and live[0].group == "UK"
    vod = {c.id: c for c in client().fetch(StreamType.VOD)}
    assert vod["20"].logo is None and vod["20"].ext == "mkv" and vod["21"].ext == "mp4"
    assert client().fetch(StreamType.SERIES)[0].name == "The Wire"


def test_episodes_are_sorted_with_their_own_extension():
    found = client().episodes("30")
    assert [(e.season, e.number, e.id, e.ext) for e in found] == [(1, 1, "300", "mkv"), (1, 2, "301", "mp4"), (2, 1, "310", "mp4")]
    assert found[1].duration == 3000
    with pytest.raises(ProviderError):
        client().episodes("../x")


def test_stream_urls_encode_the_account_and_redact_removes_it():
    assert CONFIG.stream_url(StreamType.LIVE, "10", None) == "http://prov.example:8080/live/alice/s3cret%2Fpw/10.ts"
    assert CONFIG.stream_url(StreamType.VOD, "20", "mkv").endswith("/movie/alice/s3cret%2Fpw/20.mkv")
    assert CONFIG.stream_url(StreamType.SERIES, "300", "x y").endswith("/series/alice/s3cret%2Fpw/300.mp4")
    assert "s3cret" not in CONFIG.redact("failed http://prov.example:8080/live/alice/s3cret%2Fpw/10.ts")


def test_a_failing_provider_gives_a_safe_message():
    bad = XtreamConfig("http://prov.example:8080", "alice", "wrong")
    with pytest.raises(ProviderError) as error:
        client(bad).fetch(StreamType.LIVE)
    assert "401" in str(error.value) and "wrong" not in str(error.value)
    with pytest.raises(ProviderError):
        XtreamConfig("http://u:p@host", "a", "b")


def channels(n):
    return [Channel(str(i), StreamType.VOD, f"Movie {i:02d}", "Action" if i % 2 else "Drama", added=1000 + i) for i in range(n)]


def test_store_pages_searches_groups_and_sorts(tmp_path):
    store = IptvStore(tmp_path / "s" / "iptv.db")
    assert store.counts()["vod"] == 0 and store.synced_at() is None
    store.replace(StreamType.VOD, channels(10) + [Channel("99", StreamType.VOD, "100% Wolf_Pack")], "t1")
    page, total = store.page(StreamType.VOD, None, None, "name", 0, 4)
    assert total == 11 and [c.id for c in page][:2] == ["99", "0"]
    assert store.page(StreamType.VOD, "Action", None, "name", 0, 50)[1] == 5
    assert store.page(StreamType.VOD, None, "movie 07", "name", 0, 5)[0][0].id == "7"
    assert store.page(StreamType.VOD, None, "100%", "name", 0, 5)[1] == 1  # % is not a wildcard
    assert store.page(StreamType.VOD, None, "_", "name", 0, 5)[1] == 1  # nor is _
    assert store.page(StreamType.VOD, None, None, "latest", 0, 1)[0][0].id == "9"
    assert store.page(StreamType.LIVE, None, None, "name", 0, 5) == ([], 0)
    assert [g["name"] for g in store.groups(StreamType.VOD)] == ["Action", "Drama", "Uncategorized"]
    assert store.get(StreamType.VOD, "3").name == "Movie 03" and store.get(StreamType.VOD, "nope") is None


def test_replace_swaps_one_kind_only(tmp_path):
    store = IptvStore(tmp_path / "iptv.db")
    store.replace(StreamType.VOD, channels(3), "t1")
    store.replace(StreamType.LIVE, [Channel("1", StreamType.LIVE, "BBC")], "t2")
    store.replace(StreamType.VOD, channels(1), "t3")
    assert store.counts() == {"live": 1, "vod": 1, "series": 0} and store.synced_at() == "t3"


def test_store_filters_by_category_with_group(tmp_path):
    store = IptvStore(tmp_path / "iptv.db")
    store.replace(StreamType.VOD, [
        Channel("1", StreamType.VOD, "Heat", "HOLLYWOOD | 1995"), Channel("2", StreamType.VOD, "Raja", "IN | TAMIL MOVIES (VIP)"),
        Channel("3", StreamType.VOD, "Heat Wave", "IN | TAMIL"), Channel("4", StreamType.VOD, "Other", "Drama"),
    ], "t")
    ids = lambda q: sorted(c.id for c in store.page(StreamType.VOD, None, q, "name", 0, 50)[0])  # noqa: E731
    assert ids("group:tamil") == ["2", "3"]
    assert ids('group:"tamil movies"') == ["2"]
    assert ids("heat group:tamil") == ["3"]
    assert ids("group:tamil group:vip") == ["2"]
    assert ids("group:hollywood") == ["1"] and ids("group:nope") == []
    assert ids("group:") == ["1", "2", "3", "4"]
    assert ids("group:%") == []  # % is not a wildcard

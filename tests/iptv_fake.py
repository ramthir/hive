"""A fake Xtream provider (httpx.MockTransport) for the IPTV tests."""
import httpx

from src.infrastructure.iptv.xtream import XtreamClient, XtreamConfig

CONFIG = XtreamConfig("http://prov.example:8080", "alice", "s3cret/pw")

CATEGORIES = {
    "get_live_categories": [{"category_id": "1", "category_name": "UK"}, {"category_id": "9", "category_name": "XXX Adult"}],
    "get_vod_categories": [{"category_id": "2", "category_name": "Action"}],
    "get_series_categories": [{"category_id": "3", "category_name": "Drama"}],
}
STREAMS = {
    "get_live_streams": [
        {"stream_id": 10, "name": "|UK| BBC One HD", "category_id": "1", "stream_icon": "http://img.example/bbc.png", "added": "1700000000"},
        {"stream_id": 11, "name": "Hidden", "category_id": "9"},
    ],
    "get_vod_streams": [
        {"stream_id": 20, "name": "Heat", "category_id": "2", "container_extension": "mkv", "stream_icon": "http://prov.example:8080/x.png"},
        {"stream_id": 21, "name": "Ronin 100%", "category_id": "2", "container_extension": "bad ext!"},
    ],
    "get_series": [{"series_id": 30, "name": "The Wire", "category_id": "3", "cover": "http://img.example/w.jpg"},
                   {"series_id": 31, "name": "Long Show", "category_id": "3"}],
}
EPISODES = {
    "info": {"plot": "Baltimore, told from every side.", "genre": "Crime, Drama", "cast": "Dominic West", "director": "David Simon",
             "releasedate": "2002-06-02", "rating": "9.3", "cover": "http://img.example/wire-cover.jpg", "backdrop_path": ["http://prov.example:8080/x.jpg"],
             "youtube_trailer": "dQw4w9WgXcQ"},
    "seasons": [{"season_number": 1, "name": "The Buy"}],
    "episodes": {"1": [
    {"id": "301", "season": 1, "episode_num": 2, "title": "Two", "container_extension": "mp4",
     "info": {"duration_secs": 3000, "plot": "The second.", "movie_image": "http://img.example/e2.jpg"}},
    {"id": "300", "season": 1, "episode_num": 1, "title": "One", "container_extension": "mkv"},
], "2": [{"id": "310", "season": 2, "episode_num": 1}]}}


def handler(request: httpx.Request) -> httpx.Response:
    action = request.url.params.get("action")
    if request.url.params.get("password") != "s3cret/pw":
        return httpx.Response(401)
    if action in CATEGORIES:
        return httpx.Response(200, json=CATEGORIES[action])
    if action in STREAMS:
        return httpx.Response(200, json=STREAMS[action])
    if action == "get_series_info":
        if request.url.params.get("series_id") == "31":  # many episodes, with the playlist junk some providers send as the title
            junk = '" group-title="Long Show" series-name="Long Show" season-number="1" episode-number="%d",Long Show S01 E%02d'
            return httpx.Response(200, json={"episodes": {"1": [{"id": str(400 + n), "season": 1, "episode_num": n, "title": junk % (n, n)} for n in range(1, 21)]}})
        return httpx.Response(200, json=EPISODES)
    return httpx.Response(404)


def client(config: XtreamConfig = CONFIG) -> XtreamClient:
    return XtreamClient(config, transport=httpx.MockTransport(handler))

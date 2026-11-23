"""Xtream Codes provider client (synchronous: it runs in a background thread or a worker thread).

The account's user name and password are in every stream URL. They stay here: `stream_url` is the only place that builds one, it is
used only to write a playlist for the player on this machine, and `redact` strips them from any message before it is shown.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

import httpx

from src.domain.iptv.entities import Channel, Episode, SeriesDetails, SeriesInfo, StreamType

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_SAFE_EXT = re.compile(r"^[a-z0-9]{1,10}$")
_ADULT = ("xxx", "adult", "18+", "+18", "porn", "erotic", "sex")


class ProviderError(Exception):
    """A failure whose message is safe to show: it never holds the address or the credentials."""


@dataclass(frozen=True)
class XtreamConfig:
    server: str
    username: str
    password: str
    verify_tls: bool = True

    def __post_init__(self) -> None:
        parts = urlsplit(self.server)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            raise ProviderError("XTREAM_SERVER must be an http or https address without a user name or password")

    @classmethod
    def from_env(cls) -> "XtreamConfig | None":
        server, user, password = (os.getenv(k, "").strip() for k in ("XTREAM_SERVER", "XTREAM_USERNAME", "XTREAM_PASSWORD"))
        if not (server and user and password):
            return None
        verify = os.getenv("XTREAM_VERIFY_TLS", "true").strip().lower() not in ("0", "false", "no")
        return cls(server, user, password, verify)

    @property
    def base(self) -> str:
        return self.server.rstrip("/")

    def stream_url(self, type: StreamType, provider_id: str, ext: str | None) -> str:
        user, password = quote(self.username, safe=""), quote(self.password, safe="")
        if type == StreamType.LIVE:
            return f"{self.base}/live/{user}/{password}/{provider_id}.ts"
        ext = ext if ext and _SAFE_EXT.match(ext) else "mp4"
        folder = "series" if type == StreamType.SERIES else "movie"  # an episode's own id is opened under /series/
        return f"{self.base}/{folder}/{user}/{password}/{provider_id}.{ext}"

    def redact(self, text: str) -> str:
        for secret in (self.password, quote(self.password, safe=""), self.username, quote(self.username, safe=""), self.base, urlsplit(self.server).hostname):
            if secret:
                text = text.replace(secret, "[provider]")
        return text


def _whole(value: object) -> int | None:
    try:
        return int(str(value).strip())
    except ValueError:
        return None


def _public(url: object, host: str) -> str | None:
    """A logo only when it is an http(s) image hosted somewhere other than the provider."""
    parts = urlsplit(str(url or "").strip())
    return parts.geturl() if parts.scheme in ("http", "https") and parts.hostname and parts.hostname != host else None


def _text(value: object, limit: int = 200) -> str | None:
    if value is None or isinstance(value, (list, dict)):
        return None
    text = " ".join(str(value).split())
    return text[:limit] if text and text.upper() not in ("N/A", "NONE", "NULL") else None


def _number(value: object) -> float | None:
    try:
        number = float(str(value).strip())
        return number if number == number and number != float("inf") else None
    except ValueError:
        return None


def _runtime(info: dict) -> int | None:
    seconds = _number(info.get("duration_secs"))
    if seconds and 0 < seconds < 24 * 3600:
        return int(seconds)
    parts = str(info.get("duration") or "").split(":")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        total = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return total if 0 < total < 24 * 3600 else None
    return None


_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


def _trailer_url(value: object) -> str | None:
    """A YouTube link for the provider's trailer: it sends a video id, sometimes a whole address."""
    text = str(value or "").strip()
    if _YOUTUBE_ID.match(text):
        return f"https://www.youtube.com/watch?v={text}"
    parts = urlsplit(text)
    return parts.geturl() if parts.scheme in ("http", "https") and parts.hostname in _YOUTUBE_HOSTS and not parts.username else None


class XtreamClient:
    def __init__(self, config: XtreamConfig, transport: httpx.BaseTransport | None = None) -> None:
        self.config = config
        self._http = httpx.Client(timeout=60.0, verify=config.verify_tls, follow_redirects=False, transport=transport)

    def close(self) -> None:
        self._http.close()

    def _get(self, action: str | None = None, **extra: str):
        query = {"username": self.config.username, "password": self.config.password, **extra}
        if action:
            query["action"] = action
        try:
            response = self._http.get(f"{self.config.base}/player_api.php", params=query)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as error:
            raise ProviderError(f"The provider answered with HTTP {error.response.status_code}") from None
        except httpx.TimeoutException:
            raise ProviderError("The provider did not answer in time") from None
        except (httpx.HTTPError, ValueError):
            raise ProviderError("The provider could not be reached or sent an unreadable answer") from None

    def fetch(self, type: StreamType) -> list[Channel]:
        """Every channel of one kind, without the adult categories."""
        kind, id_key, logo_key, added_key = {
            StreamType.LIVE: ("live", "stream_id", "stream_icon", "added"),
            StreamType.VOD: ("vod", "stream_id", "stream_icon", "added"),
            StreamType.SERIES: ("series", "series_id", "cover", "last_modified"),
        }[type]
        categories = self._get(f"get_{kind}_categories")
        categories = [c for c in categories if isinstance(c, dict)] if isinstance(categories, list) else []
        names = {str(c.get("category_id")): c.get("category_name") or "Uncategorized" for c in categories}
        adult = {
            str(c.get("category_id")) for c in categories
            if str(c.get("is_adult")) == "1" or any(w in str(c.get("category_name", "")).lower() for w in _ADULT)
        }
        streams = self._get("get_series" if type == StreamType.SERIES else f"get_{kind}_streams")
        host = urlsplit(self.config.server).hostname or ""
        out = []
        for s in streams if isinstance(streams, list) else []:
            if not isinstance(s, dict):
                continue
            pid, category = str(s.get(id_key, "")), str(s.get("category_id", ""))
            if not _SAFE_ID.match(pid) or category in adult:
                continue
            ext = str(s.get("container_extension") or "").lower()
            seconds = _whole(s.get(added_key))
            out.append(Channel(
                id=pid, type=type, name=str(s.get("name") or "Unknown").strip(), group=names.get(category, "Uncategorized"),
                logo=_public(s.get(logo_key), host),
                ext=(ext if _SAFE_EXT.match(ext) else "mp4") if type == StreamType.VOD else None,
                added=seconds if seconds and 0 < seconds < 4_102_444_800 else None,
            ))
        return out

    def series_details(self, series_id: str) -> SeriesDetails:
        """A series' facts and its episodes. Images hosted by the provider itself are left out."""
        if not _SAFE_ID.match(series_id):
            raise ProviderError("That series cannot be looked up")
        body = self._get("get_series_info", series_id=series_id)
        body = body if isinstance(body, dict) else {}
        info = body.get("info") if isinstance(body.get("info"), dict) else {}
        host = urlsplit(self.config.server).hostname or ""
        names = {}
        for season in body.get("seasons") if isinstance(body.get("seasons"), list) else []:
            number = _whole(season.get("season_number")) if isinstance(season, dict) else None
            if number is not None and _text(season.get("name"), 80):
                names[number] = _text(season.get("name"), 80)
        grouped = body.get("episodes")
        lists = grouped.values() if isinstance(grouped, dict) else [grouped] if isinstance(grouped, list) else []
        found = []
        for items in lists:
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict):
                    continue
                eid, season, number = str(item.get("id", "")), _whole(item.get("season")), _whole(item.get("episode_num"))
                if not _SAFE_ID.match(eid) or season is None or number is None or season < 0 or number < 0:
                    continue
                details = item.get("info") if isinstance(item.get("info"), dict) else {}
                ext = str(item.get("container_extension") or "").lower()
                found.append(Episode(eid, season, number, _text(item.get("title")), ext if _SAFE_EXT.match(ext) else "mp4",
                                     _runtime(details), _text(details.get("plot"), 1500), _public(details.get("movie_image"), host)))
        found.sort(key=lambda e: (e.season, e.number, e.id))
        return SeriesDetails(self._facts(info, host), tuple(found), names)

    @staticmethod
    def _facts(info: dict, host: str) -> SeriesInfo:
        release = _text(info.get("releasedate") or info.get("release_date") or info.get("releaseDate"), 10)
        release = release if release and re.match(r"^\d{4}-\d{2}-\d{2}$", release) else None
        year = int(release[:4]) if release else None
        rating = _number(info.get("rating"))
        backdrop = info.get("backdrop_path")
        backdrop = backdrop[0] if isinstance(backdrop, list) and backdrop else backdrop
        return SeriesInfo(
            plot=_text(info.get("plot") or info.get("description"), 3000), genre=_text(info.get("genre")), director=_text(info.get("director")),
            cast=_text(info.get("cast") or info.get("actors"), 600), release_date=release, year=year if year and 1880 <= year <= 2100 else None,
            rating=round(rating, 1) if rating is not None and 0 < rating <= 10 else None, country=_text(info.get("country")),
            age=_text(info.get("age"), 20), poster=_public(info.get("cover") or info.get("cover_big") or info.get("movie_image"), host),
            backdrop=_public(backdrop, host), trailer_url=_trailer_url(info.get("youtube_trailer")),
        )

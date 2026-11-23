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

from src.domain.iptv.entities import Channel, Episode, StreamType

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

    def episodes(self, series_id: str) -> list[Episode]:
        if not _SAFE_ID.match(series_id):
            raise ProviderError("That series cannot be looked up")
        body = self._get("get_series_info", series_id=series_id)
        grouped = body.get("episodes") if isinstance(body, dict) else None
        lists = grouped.values() if isinstance(grouped, dict) else [grouped] if isinstance(grouped, list) else []
        found = []
        for items in lists:
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict):
                    continue
                eid, season, number = str(item.get("id", "")), _whole(item.get("season")), _whole(item.get("episode_num"))
                if not _SAFE_ID.match(eid) or season is None or number is None or season < 0 or number < 0:
                    continue
                info = item.get("info") if isinstance(item.get("info"), dict) else {}
                ext = str(item.get("container_extension") or "").lower()
                secs = _whole(info.get("duration_secs"))
                found.append(Episode(eid, season, number, _text(item.get("title")), ext if _SAFE_EXT.match(ext) else "mp4",
                                     secs if secs and 0 < secs < 86400 else None))
        return sorted(found, key=lambda e: (e.season, e.number, e.id))

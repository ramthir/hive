"""The IPTV catalogue and the stream URLs you copy into a player such as VLC. Hive never streams."""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone

from src.domain.iptv.entities import Channel, Episode, StreamType
from src.infrastructure.iptv.store import IptvStore
from src.infrastructure.iptv.xtream import ProviderError, XtreamClient

log = logging.getLogger("hive.iptv")
EPISODES_TTL = 24 * 3600


class NotConfigured(Exception):
    pass


class NotFound(Exception):
    pass


def _one_line(text: str) -> str:
    return " ".join(text.split())


class IptvCatalog:
    def __init__(self, store: IptvStore, client_factory: Callable[[], XtreamClient | None], clock: Callable[[], float] = time.monotonic) -> None:
        self.store = store
        self._factory = client_factory
        self._clock = clock
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status = {"running": False, "progress": "", "error": None}
        self._episodes: dict[str, tuple[float, list[Episode]]] = {}

    @property
    def configured(self) -> bool:
        return self._factory() is not None

    def status(self) -> dict:
        counts = self.store.counts()
        return {"configured": self.configured, **self._status, "synced_at": self.store.synced_at(), "counts": counts}

    def start_sync(self) -> bool:
        """Start a sync in the background; False when one is already running."""
        with self._lock:
            if self._status["running"]:
                return False
            client = self._factory()
            if client is None:
                raise NotConfigured()
            self._status.update(running=True, progress="Starting", error=None)
            self._thread = threading.Thread(target=self._run, args=(client,), name="iptv-sync", daemon=True)
            self._thread.start()
            return True

    def wait(self, timeout: float | None = None) -> None:
        if self._thread:
            self._thread.join(timeout)

    def _run(self, client: XtreamClient) -> None:
        try:
            fetched = {}
            for kind, label in ((StreamType.LIVE, "live channels"), (StreamType.VOD, "movies"), (StreamType.SERIES, "series")):
                self._status["progress"] = f"Fetching {label}"
                fetched[kind] = client.fetch(kind)  # everything is fetched first, so a failure changes nothing
            self._status["progress"] = "Saving"
            now = datetime.now(timezone.utc).isoformat()
            for kind, items in fetched.items():
                if items:  # an empty answer is more likely a provider fault than an emptied catalogue
                    self.store.replace(kind, items, now)
            self._status["progress"] = "Complete"
        except ProviderError as error:
            self._status.update(error=str(error), progress="Failed")
        except Exception:
            log.exception("IPTV sync failed")
            self._status.update(error="Sync failed", progress="Failed")
        finally:
            self._status["running"] = False
            client.close()

    def episodes(self, series_id: str) -> list[Episode]:
        if self.store.get(StreamType.SERIES, series_id) is None:
            raise NotFound()
        cached = self._episodes.get(series_id)
        if cached and self._clock() - cached[0] < EPISODES_TTL:
            return cached[1]
        client = self._factory()
        if client is None:
            raise NotConfigured()
        try:
            found = client.episodes(series_id)
        finally:
            client.close()
        self._episodes[series_id] = (self._clock(), found)
        return found

    def stream_url(self, type: StreamType, provider_id: str, episode_id: str | None = None) -> tuple[str, str]:
        """(title, stream URL) of one live channel, movie or episode, to paste into a player. The URL holds the account's password, so it is
        given only when asked for (never in a listing) and Hive answers localhost only."""
        channel = self.store.get(type, provider_id)
        if channel is None:
            raise NotFound()
        client = self._factory()
        if client is None:
            raise NotConfigured()
        try:
            if type == StreamType.SERIES:
                episode = next((e for e in self.episodes(provider_id) if e.id == episode_id), None)
                if episode is None:
                    raise NotFound()
                title = f"{channel.name} S{episode.season:02d}E{episode.number:02d}" + (f" {episode.title}" if episode.title else "")
                url = client.config.stream_url(StreamType.SERIES, episode.id, episode.ext)
            else:
                title, url = channel.name, client.config.stream_url(type, channel.id, channel.ext)
        finally:
            client.close()
        return _one_line(title), url

"""IPTV entities. A channel holds the provider's id, never a stream URL (those carry the account's password)."""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class StreamType(StrEnum):
    LIVE = "live"
    VOD = "vod"
    SERIES = "series"  # listed like a movie, but only its episodes can be played


@dataclass(frozen=True)
class Channel:
    id: str  # the provider's id
    type: StreamType
    name: str
    group: str = "Uncategorized"
    logo: str | None = None
    ext: str | None = None  # a movie's container extension
    added: int | None = None  # when the provider added it (epoch seconds)


@dataclass(frozen=True)
class Episode:
    id: str
    season: int
    number: int
    title: str | None = None
    ext: str = "mp4"
    duration: int | None = None  # seconds

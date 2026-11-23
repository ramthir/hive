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
    plot: str | None = None
    image: str | None = None


@dataclass(frozen=True)
class SeriesInfo:
    """What the provider knows about a series. Every field is optional: many series have little metadata."""

    plot: str | None = None
    genre: str | None = None
    director: str | None = None
    cast: str | None = None
    release_date: str | None = None
    year: int | None = None
    rating: float | None = None  # out of 10
    country: str | None = None
    age: str | None = None
    poster: str | None = None
    backdrop: str | None = None
    trailer_url: str | None = None


@dataclass(frozen=True)
class SeriesDetails:
    info: SeriesInfo
    episodes: tuple[Episode, ...] = ()  # sorted by season and number
    season_names: dict[int, str] | None = None  # the provider's name for a season, when it gives one

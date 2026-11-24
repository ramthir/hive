"""IPTV: the provider's catalogue (cached in SQLite) and the stream URL of a channel, to copy into a player such as VLC."""
from __future__ import annotations

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from src.application.iptv.catalog import NotConfigured, NotFound
from src.application.iptv.names import clean_channel_name
from src.domain.iptv.entities import Channel, StreamType
from src.infrastructure.iptv.xtream import ProviderError

router = APIRouter(prefix="/iptv")


def _out(c: Channel) -> dict:
    out = {"id": c.id, "type": c.type.value, "name": c.name, "group": c.group, "logo": c.logo, "added": c.added, "starred": c.starred}
    if c.type == StreamType.LIVE:  # the stored name stays as the provider sent it (a sync brings it back); it is cleaned when read
        clean = clean_channel_name(c.name)
        out.update(display_name=clean.name, quality=clean.quality, note=clean.note)
    return out


def _catalog(request: Request):
    return request.app.state.iptv


@router.get("/status")
def status(request: Request) -> dict:
    return _catalog(request).status()


@router.post("/sync", status_code=202)
def sync(request: Request) -> dict:
    try:
        started = _catalog(request).start_sync()
    except NotConfigured:
        raise HTTPException(409, "The IPTV provider is not configured") from None
    return {"started": started}


@router.get("/channels")
def channels(request: Request, type: StreamType, group: str | None = Query(None, max_length=255), q: str | None = Query(None, max_length=200),
             sort: Literal["name", "latest", "oldest"] = "name", page: int = Query(0, ge=0), page_size: int = Query(48, ge=1, le=100)) -> dict:
    items, total = _catalog(request).store.page(type, group or None, q, sort, page, page_size)
    return {"items": [_out(c) for c in items], "total": total, "page": page, "page_size": page_size,
            "total_pages": (total + page_size - 1) // page_size}


@router.get("/groups")
def groups(request: Request, type: StreamType) -> list[dict]:
    return _catalog(request).store.groups(type)


@router.put("/star")
def star(request: Request, type: StreamType, id: str = Query(max_length=32)) -> dict:
    if not _catalog(request).store.set_starred(type, id, True):
        raise HTTPException(404, "Not found")
    return {"starred": True}


@router.delete("/star")
def unstar(request: Request, type: StreamType, id: str = Query(max_length=32)) -> dict:
    if not _catalog(request).store.set_starred(type, id, False):
        raise HTTPException(404, "Not found")
    return {"starred": False}


@router.get("/series/{series_id}")
def series(request: Request, series_id: str) -> dict:
    """A series for its page: the provider's facts and its episodes by season."""
    try:
        channel, details = _catalog(request).series(series_id)
    except NotFound:
        raise HTTPException(404, "Series not found") from None
    except NotConfigured:
        raise HTTPException(409, "The IPTV provider is not configured") from None
    except ProviderError as error:
        raise HTTPException(502, str(error)) from None
    seasons: dict[int, list[dict]] = {}
    for e in details.episodes:
        seasons.setdefault(e.season, []).append(
            {"id": e.id, "number": e.number, "title": e.title, "plot": e.plot, "duration": e.duration, "image": e.image})
    names = details.season_names or {}
    return {**_out(channel), "info": asdict(details.info),
            "seasons": [{"number": n, "name": names.get(n) or f"Season {n}", "episodes": eps} for n, eps in seasons.items()]}


@router.get("/stream-url")
def stream_url(request: Request, type: StreamType, id: str = Query(max_length=32), episode: str | None = Query(None, max_length=32)) -> JSONResponse:
    """The provider's stream URL for one channel, movie or episode, for the page's Copy URL button. It carries the account's password, so it
    is asked for one at a time and never cached."""
    try:
        title, url = _catalog(request).stream_url(type, id, episode)
    except NotFound:
        raise HTTPException(404, "Not found") from None
    except NotConfigured:
        raise HTTPException(409, "The IPTV provider is not configured") from None
    except ProviderError as error:
        raise HTTPException(502, str(error)) from None
    return JSONResponse({"title": title, "url": url}, headers={"Cache-Control": "no-store"})

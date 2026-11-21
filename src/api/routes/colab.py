"""Colab tab data: compute-unit usage, active runtimes and live machine stats and processes through the local `colab` CLI
(`colab usage`, `colab sessions`, and a fixed read-only probe sent with `colab exec`). The live numbers come from one collector per
runtime (`ColabCollector`, owned by the app) that is started by a viewer of `/api/colab/stream`; the stats and processes routes
only read what it has collected and never start a probe."""
import asyncio
import json
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from src.domain.colab.errors import ColabBusyError, ColabCliError
from src.domain.colab.parsing import validate_session_name
from src.infrastructure.colab.cli import get_colab_sessions, get_colab_usage


_stats_cache: dict[str, dict[str, Any]] = {}
_processes_cache: dict[str, list[dict[str, Any]]] = {}

router = APIRouter(prefix="/colab")


def get_colab_stats(request: Request, session: dict[str, str]) -> dict[str, Any]:
    """What the collector last collected for this runtime; never starts a probe."""
    data = request.app.state.colab.cached(session)
    if data['stats'] is None:
        raise ColabBusyError(data['message'])
    return data['stats']


def get_colab_processes(request: Request, session: dict[str, str]) -> list[dict[str, Any]]:
    return request.app.state.colab.cached(session)['processes']


async def _resolve_active_session(
    session: Optional[str],
) -> tuple[Optional[dict[str, str]], Optional[dict[str, Any]]]:
    """Resolve an active Colab session without ever auto-creating a new VM."""
    if session is not None:
        try:
            validate_session_name(session)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        sessions = await get_colab_sessions()
    except ColabCliError as exc:
        return None, {"reachable": False, "active": False, "session": None, "error": str(exc)}

    if not sessions:
        return None, {
            "reachable": True,
            "active": False,
            "session": None,
            "error": "No active session",
        }

    matched = sessions[0]
    if session is not None:
        found = next((item for item in sessions if item["name"] == session), None)
        if found is None:
            return None, {
                "reachable": True,
                "active": False,
                "session": None,
                "error": f"Session '{session}' is not active",
            }
        matched = found

    return matched, None


@router.get("/health")
async def colab_health():
    """Return dashboard tab availability for Colab."""
    return {"reachable": True}


@router.get("/usage")
async def colab_usage():
    """Return compute-unit balance, usage rate, and active assignments."""
    try:
        usage = await get_colab_usage()
        return {"reachable": True, **usage}
    except ColabCliError as exc:
        return {"reachable": False, "error": str(exc)}


@router.get("/sessions")
async def colab_sessions():
    """Return currently active Colab sessions."""
    try:
        sessions = await get_colab_sessions()
        return {"reachable": True, "sessions": sessions}
    except ColabCliError as exc:
        return {"reachable": False, "sessions": [], "error": str(exc)}


@router.get("/stats")
async def colab_stats(request: Request, session: Optional[str] = Query(default=None)):
    """Return live machine stats for an active Colab session via `colab exec`."""
    matched, error_body = await _resolve_active_session(session)
    if error_body is not None or matched is None:
        return error_body

    try:
        stats = get_colab_stats(request, matched)
        _stats_cache[matched.get("runtime_id", matched["name"])] = stats
        return {"reachable": True, "active": True, "busy": False, "session": matched, **stats}
    except ColabBusyError:
        cached = _stats_cache.get(matched.get("runtime_id", matched["name"]), {})
        return {
            "reachable": True,
            "active": True,
            "busy": True,
            "session": matched,
            "message": "A Colab status probe is busy; waiting for next refresh.",
            **cached,
        }
    except ColabCliError as exc:
        return {
            "reachable": False,
            "active": True,
            "busy": False,
            "session": matched,
            "error": str(exc),
        }


def _paginate_processes(
    processes: list[dict[str, Any]],
    page: int,
    page_size: int,
    sort: Literal["cpu_percent", "mem_percent"],
    direction: Literal["asc", "desc"],
) -> dict[str, Any]:
    """Sort and slice a process list into the standard paginated response."""
    reverse = direction == "desc"
    sorted_procs = sorted(
        processes,
        key=lambda item: (float(item.get(sort) or 0.0), -int(item.get("pid") or 0) if reverse else int(item.get("pid") or 0)),
        reverse=reverse,
    )
    total = len(sorted_procs)
    total_pages = max(1, (total + page_size - 1) // page_size)
    current_page = min(page, total_pages)
    start = (current_page - 1) * page_size
    return {
        "processes": sorted_procs[start : start + page_size],
        "page": current_page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }


@router.get("/processes")
async def colab_processes(
    request: Request,
    session: Optional[str] = Query(default=None),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 10,
    sort: Literal["cpu_percent", "mem_percent"] = "cpu_percent",
    direction: Literal["asc", "desc"] = "desc",
):
    """Return running processes for an active Colab session via `colab exec`."""
    matched, error_body = await _resolve_active_session(session)
    if error_body is not None or matched is None:
        return {**(error_body or {}), **_paginate_processes([], page, page_size, sort, direction)}

    try:
        processes = get_colab_processes(request, matched)
        _processes_cache[matched.get("runtime_id", matched["name"])] = processes
        return {
            "reachable": True,
            "active": True,
            "busy": False,
            "session": matched,
            **_paginate_processes(processes, page, page_size, sort, direction),
        }
    except ColabBusyError:
        cached = _processes_cache.get(matched.get("runtime_id", matched["name"]), [])
        return {
            "reachable": True,
            "active": True,
            "busy": True,
            "session": matched,
            **_paginate_processes(cached, page, page_size, sort, direction),
            "message": "A Colab status probe is busy; waiting for next refresh.",
        }
    except ColabCliError as exc:
        return {
            "reachable": False,
            "active": True,
            "busy": False,
            "session": matched,
            **_paginate_processes([], page, page_size, sort, direction),
            "error": str(exc),
        }


@router.get('/stream')
async def colab_stream(request: Request, session: Optional[str] = Query(default=None)):
    matched, error = await _resolve_active_session(session)
    if error or matched is None:
        raise HTTPException(status_code=409, detail=(error or {}).get('error', 'No active Colab session'))

    async def events():
        yield 'retry: 5000\n\n'
        async with request.app.state.colab.subscribe(matched) as queue:
            while not await request.is_disconnected():
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=15)
                    yield 'event: status\ndata: ' + json.dumps(data) + '\n\n'
                except asyncio.TimeoutError:
                    yield ': keep-alive\n\n'

    return StreamingResponse(events(), media_type='text/event-stream', headers={
        'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
    })

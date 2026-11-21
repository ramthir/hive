"""Colab tab data: compute-unit usage, active runtimes and live machine stats and processes through the local `colab` CLI
(`colab usage`, `colab sessions`, and a fixed read-only probe sent with `colab exec`). The live numbers come from one collector per
runtime (`ColabCollector`, owned by the app) that is started by a viewer of `/api/colab/stream`; there is no other way to start a probe."""
import asyncio
import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from src.domain.colab.errors import ColabCliError
from src.domain.colab.parsing import validate_session_name
from src.infrastructure.colab.cli import get_colab_sessions, get_colab_usage


router = APIRouter(prefix="/colab")


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

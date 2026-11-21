from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

router = APIRouter()


@router.get("/events")
async def events(request: Request, note: str | None = Query(None, max_length=200), type: str | None = Query(None, max_length=100)) -> StreamingResponse:
    """Server-sent `change` events for notes that changed, in Hive or outside it. `note=<slug>` sends only that note,
    `type=task` only notes of that type (also ones that just stopped being it); neither sends all. Each event is
    `{slug, title, revision, deleted, types}`, or `{reset: true}` when anything may have changed: look again."""
    sub = request.app.state.notes.feed.subscribe(note, type)

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(sub.queue.get(), timeout=15)
                    yield "event: change\ndata: " + json.dumps(event) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            sub.close()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

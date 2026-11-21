import asyncio
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.api.routes import events as events_routes
from src.application.notes.service import NoteService
from src.infrastructure.fs_notes.repository import FileNoteRepository


@pytest.fixture
def svc(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    return NoteService(FileNoteRepository(tmp_path))


@pytest.mark.asyncio
async def test_the_stream_sends_a_change_for_the_note_it_was_asked_about_and_unsubscribes_on_leaving(svc):
    svc.create("Alpha", "# Alpha\n", (), ())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(notes=svc)), is_disconnected=AsyncMock(return_value=False))
    response = await events_routes.events(request, note="alpha", type=None)
    assert response.media_type == "text/event-stream" and response.headers["x-accel-buffering"] == "no"
    stream = response.body_iterator
    assert await anext(stream) == "retry: 3000\n\n"
    assert svc.feed.active
    saved = svc.update("alpha", content="# Alpha\n\nchanged")
    svc.update("alpha", content="# Alpha\n\nchanged again")
    chunk = await asyncio.wait_for(anext(stream), 2)
    assert chunk.startswith("event: change\ndata: ")
    event = json.loads(chunk.split("data: ", 1)[1])
    assert event["slug"] == "alpha" and event["revision"] == saved.revision
    await stream.aclose()
    assert not svc.feed.active


def test_the_route_is_served_by_the_app(tmp_path):
    from src.api.main import create_app
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    assert "/api/events" in create_app(tmp_path, watch=False).openapi()["paths"]

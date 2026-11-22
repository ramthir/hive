"""Chat with the notes through Codex. Nothing is stored here: the page keeps the conversation and the id of its Codex session."""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.application.chat.service import MAX_MESSAGE_CHARS, MAX_SELECTION_CHARS

NOTE_SLUG = r"^[\w][\w-]*$"  # a note file name: no path, no dots, no quotes, no line breaks

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_MESSAGE_CHARS * 2)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    session: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    note: str | None = Field(default=None, pattern=NOTE_SLUG, max_length=200)  # the note the chat is about (its slug): a chat beside a note
    selection: str = Field(default="", max_length=MAX_SELECTION_CHARS * 2)  # the text selected in that note


@router.get("/chat/status")
def status(request: Request) -> dict:
    chat = request.app.state.chat
    return {"available": chat.available,
            "reason": None if chat.available else chat.missing}


@router.delete("/chat/session", status_code=204)
def new_chat(request: Request, note: str | None = Query(default=None, pattern=NOTE_SLUG, max_length=200)) -> None:
    """"New chat": forget the Codex session kept on the server (with `note`, only that note's chat)."""
    request.app.state.chat.reset(note)


@router.post("/chat")
def chat(request: Request, body: ChatRequest) -> StreamingResponse:
    """Server-sent events: `session` (the Codex session to send back with the next question), `step` (a notes tool running), `message` (Codex's latest text; the last one is the answer), `done`,
    `error` and `changed` (the notes the answer saved). A plain `def` stream: it runs in a worker thread, and a client that
    leaves stops Codex."""
    service = request.app.state.chat
    messages = [m.model_dump() for m in body.messages]

    def events():
        try:
            for event in service.stream(messages, body.session, body.note, body.selection):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as error:  # the stream is already open: tell the page instead of cutting it
            yield f"data: {json.dumps({'type': 'error', 'message': str(error) or type(error).__name__})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

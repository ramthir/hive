from __future__ import annotations

import hashlib
import re
from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from src.application.diagrams.service import DiagramService
from src.domain.notes.diagrams import plantuml_blocks
from src.domain.notes.errors import NoteNotFound

router = APIRouter()


class RenderRequest(BaseModel):
    source: str = Field(max_length=2_000_000)  # the service enforces the real limit with a clear message


class RenderResponse(BaseModel):
    svg: str


def diagrams(request: Request) -> DiagramService:
    return request.app.state.diagrams


# Plain `def`: FastAPI runs these in a threadpool, so the Java process never blocks the event loop.

@router.get("/diagram/status")
def status(request: Request) -> dict:
    return diagrams(request).status()


@router.post("/diagram/render", response_model=RenderResponse)
def render(request: Request, body: RenderRequest) -> RenderResponse:
    return RenderResponse(svg=diagrams(request).render(body.source))


class PngRequest(RenderRequest):
    theme: Literal["dark", "light"] = "dark"


@router.post("/diagram/render/png")
def render_png(request: Request, body: PngRequest) -> Response:
    return Response(content=diagrams(request).render_png(body.source, body.theme), media_type="image/png")


# Embeds: `![alt](/notes/<slug>/diagram.svg?n=2&v=<revision>)` shows the note's nth plantuml fence. Not under /api: it is the address
# the note's own markdown names. Registered before the note page routes (main.py).
embeds = APIRouter()

# The image is only ever shown by an <img>, which runs no script; the sandbox keeps it harmless when the address is opened itself.
EMBED_HEADERS = {"Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff"}


def embed_source(request: Request, slug: str, n: int) -> str:
    blocks = plantuml_blocks(request.app.state.notes.get(slug).content)  # NoteNotFound / InvalidSlug answer 404 / 422
    if n > len(blocks):
        found = f"has {len(blocks)}" if blocks else "has no"
        raise NoteNotFound(f"{slug} {found} diagram{'s' if len(blocks) != 1 else ''}: there is no diagram {n}")
    return blocks[n - 1]


def embed_response(request: Request, body: bytes, media_type: str, version: str | None, extra: dict[str, str] | None = None) -> Response:
    """`v` (the note's revision) makes the address unique to this text, so it can be kept; without it the browser asks again (a 304 when
    nothing changed)."""
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    headers = {**EMBED_HEADERS, **(extra or {}), "ETag": etag,
               "Cache-Control": "private, max-age=31536000, immutable" if version else "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type=media_type, headers=headers)


@embeds.get("/notes/{slug}/diagram.svg")
def note_diagram_svg(request: Request, slug: str, n: int = Query(1, ge=1), v: str | None = None) -> Response:
    svg = diagrams(request).render(embed_source(request, slug, n))
    return embed_response(request, svg.encode(), "image/svg+xml", v)


@embeds.get("/notes/{slug}/diagram.png")
def note_diagram_png(request: Request, slug: str, n: int = Query(1, ge=1), v: str | None = None, theme: Literal["dark", "light"] = "dark") -> Response:
    png = diagrams(request).render_png(embed_source(request, slug, n), theme)
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", slug) or "diagram"
    return embed_response(request, png, "image/png", v, {"Content-Disposition": f'inline; filename="{name}-{n}-{theme}.png"'})

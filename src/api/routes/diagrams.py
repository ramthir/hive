from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from src.application.diagrams.service import DiagramService

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

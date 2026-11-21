"""Agents page data: this month's token usage of Claude, Codex and Antigravity."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request

from src.domain.agents.usage import MAX_PAGE_SIZE

# Plain functions: the first report of a month waits for ccusage, so FastAPI runs them in a worker thread.
router = APIRouter()


@router.get("/agents/usage")
def usage(request: Request) -> dict:
    """Totals, daily trend and health for the current month."""
    return request.app.state.agents.view()


@router.get("/agents/usage/sessions")
def sessions(request: Request,
             sort: Literal["last_activity", "provider", "input", "cached", "output", "total"] = "last_activity",
             direction: Literal["asc", "desc"] = Query("desc", alias="dir"),
             page: int = Query(0, ge=0), page_size: int = Query(10, ge=1, le=MAX_PAGE_SIZE)) -> dict:
    """One page of this month's sessions, sorted across all of them."""
    return request.app.state.agents.sessions(sort, direction, page, page_size)

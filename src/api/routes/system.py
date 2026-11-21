"""Dashboard data: what is running in the container Hive is in."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request

# Plain functions: psutil blocks, so FastAPI runs them in a worker thread.
router = APIRouter()


@router.get("/system/stats")
def stats(request: Request) -> dict:
    return request.app.state.system.stats()


@router.get("/system/processes")
def processes(request: Request, page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=100),
              sort: Literal["cpu_percent", "mem_percent"] = "cpu_percent",
              direction: Literal["asc", "desc"] = "desc") -> dict:
    """One page of the container's processes."""
    return request.app.state.system.process_page(page, page_size, sort, direction)

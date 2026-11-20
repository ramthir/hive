"""FastAPI app factory."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from src.api.routes import notes
from src.application.notes.service import NoteService
from src.domain.notes.errors import GitError, InvalidSlug, InvalidTitle, NoteExists, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.git.client import GitClient
from src.infrastructure.metrics import Metrics
from src.infrastructure.watcher import NotesWatcher


def create_app(notes_dir: str | Path | None = None, watch: bool | None = None) -> FastAPI:
    load_dotenv()
    root = Path(notes_dir or os.environ.get("NOTES_DIR", "~/Workspace/notes")).expanduser().resolve()
    metrics = Metrics()
    git = GitClient(root, metrics)
    if not root.is_dir() or not git.is_repo():
        raise RuntimeError(f"NOTES_DIR {root} must be an existing git working tree")

    service = NoteService(FileNoteRepository(root, git), metrics)
    if watch is None:
        watch = os.environ.get("HIVE_WATCH", "1") != "0"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        watcher = NotesWatcher(root, lambda _paths: service.invalidate(), metrics) if watch else None
        if watcher:
            watcher.start()
        try:
            yield
        finally:
            if watcher:
                watcher.stop()

    app = FastAPI(title="Hive Notes", lifespan=lifespan)
    app.state.notes = service
    app.state.metrics = metrics

    def err(status: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            return JSONResponse({"detail": str(exc)}, status_code=status)
        return handler

    app.add_exception_handler(NoteNotFound, err(404))
    app.add_exception_handler(NoteExists, err(409))
    app.add_exception_handler(InvalidSlug, err(422))
    app.add_exception_handler(InvalidTitle, err(422))
    app.add_exception_handler(GitError, err(500))
    app.include_router(notes.router, prefix="/api")

    @app.get("/api/metrics")
    def get_metrics() -> dict:
        return {**metrics.snapshot(), "watcher": bool(watch)}

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "notes_dir": str(root)}

    static = Path(__file__).resolve().parents[2] / "static"
    app.mount("/static", StaticFiles(directory=static), name="static")

    @app.get("/", include_in_schema=False)
    @app.get("/notes", include_in_schema=False)
    @app.get("/notes/{path:path}", include_in_schema=False)
    def spa(path: str = "") -> FileResponse:
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})

    return app

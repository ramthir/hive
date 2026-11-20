"""FastAPI app factory."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from src.api.routes import notes
from src.application.notes.service import NoteService
from src.domain.notes.errors import GitError, InvalidSlug, NoteExists, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.git.client import GitClient


def create_app(notes_dir: str | Path | None = None) -> FastAPI:
    load_dotenv()
    root = Path(notes_dir or os.environ.get("NOTES_DIR", "~/Workspace/notes")).expanduser().resolve()
    git = GitClient(root)
    if not root.is_dir() or not git.is_repo():
        raise RuntimeError(f"NOTES_DIR {root} must be an existing git working tree")

    app = FastAPI(title="Hive Notes")
    app.state.notes = NoteService(FileNoteRepository(root, git))

    def err(status: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            return JSONResponse({"detail": str(exc)}, status_code=status)
        return handler

    app.add_exception_handler(NoteNotFound, err(404))
    app.add_exception_handler(NoteExists, err(409))
    app.add_exception_handler(InvalidSlug, err(422))
    app.add_exception_handler(GitError, err(500))
    app.include_router(notes.router, prefix="/api")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "notes_dir": str(root)}

    return app

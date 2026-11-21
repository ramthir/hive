"""FastAPI app factory."""
from __future__ import annotations

import logging
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from src.api.routes import diagrams, notes
from src.application.diagrams.service import DiagramError, DiagramService
from src.application.notes.service import NoteService
from src.domain.notes.errors import GitError, InvalidProperty, InvalidSlug, InvalidTime, InvalidTitle, NoteConflict, NoteExists, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.agents.codex import CodexCommitMessages, codex_program
from src.infrastructure.git.client import GitClient
from src.infrastructure.git.rewording import CommitRewriter
from src.infrastructure.metrics import Metrics
from src.infrastructure.watcher import NotesWatcher


def commit_rewriter(git: GitClient, metrics: Metrics) -> CommitRewriter | None:
    """HIVE_COMMIT_MESSAGES=codex: after each save, Codex reads the diff and replaces "doc: update Title" with a message
    about the change. Off by default because the diff of the note is sent to the model."""
    if os.environ.get("HIVE_COMMIT_MESSAGES", "").strip().lower() != "codex":
        return None
    program = codex_program(os.environ.get("HIVE_CODEX"))
    if not program:
        logging.getLogger("hive.commit_messages").warning("HIVE_COMMIT_MESSAGES=codex but codex was not found (set HIVE_CODEX)")
        return None
    return CommitRewriter(git, CodexCommitMessages(program, os.environ.get("HIVE_CODEX_MODEL") or None, effort=os.environ.get("HIVE_CODEX_EFFORT") or None), metrics)


def create_app(notes_dir: str | Path | None = None, watch: bool | None = None,
               diagram_service: DiagramService | None = None) -> FastAPI:
    load_dotenv()
    root = Path(notes_dir or os.environ.get("NOTES_DIR", "~/Workspace/notes")).expanduser().resolve()
    metrics = Metrics()
    git = GitClient(root, metrics)
    if not root.is_dir() or not git.is_repo():
        raise RuntimeError(f"NOTES_DIR {root} must be an existing git working tree")

    rewriter = commit_rewriter(git, metrics)
    service = NoteService(FileNoteRepository(root, git, after_commit=rewriter.submit if rewriter else None), metrics)
    if watch is None:
        watch = os.environ.get("HIVE_WATCH", "1") != "0"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        watcher = NotesWatcher(root, service.invalidate, metrics) if watch else None
        if watcher:
            watcher.start()
        try:
            yield
        finally:
            if watcher:
                watcher.stop()

    if diagram_service is None:
        diagram_service = DiagramService(
            java=os.environ.get("PLANTUML_JAVA") or shutil.which("java"),
            jar=os.environ.get("PLANTUML_JAR", "~/.local/share/hive/plantuml/plantuml.jar"),
            notes_dir=root, metrics=metrics)

    diagram_service.metrics = metrics  # one set of metrics for the whole app (/api/metrics)
    app = FastAPI(title="Hive Notes", lifespan=lifespan)
    app.state.notes = service
    app.state.diagrams = diagram_service
    app.state.metrics = metrics

    def err(status: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            return JSONResponse({"detail": str(exc)}, status_code=status)
        return handler

    app.add_exception_handler(NoteNotFound, err(404))
    app.add_exception_handler(NoteExists, err(409))
    app.add_exception_handler(NoteConflict, err(412))
    app.add_exception_handler(InvalidSlug, err(422))
    app.add_exception_handler(InvalidTitle, err(422))
    app.add_exception_handler(InvalidTime, err(422))
    app.add_exception_handler(InvalidProperty, err(422))
    app.add_exception_handler(GitError, err(500))

    async def diagram_error(_: Request, exc: DiagramError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    app.add_exception_handler(DiagramError, diagram_error)
    app.include_router(notes.router, prefix="/api")
    app.include_router(diagrams.router, prefix="/api")

    @app.get("/api/metrics")
    def get_metrics() -> dict:
        return {**metrics.snapshot(), "watcher": bool(watch)}

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "notes_dir": str(root)}

    static = Path(__file__).resolve().parents[2] / "static"
    app.mount("/static", StaticFiles(directory=static), name="static")

    @app.get("/tasks", include_in_schema=False)
    def tasks_page() -> FileResponse:
        return FileResponse(static / "tasks.html", headers={"Cache-Control": "no-cache"})

    @app.get("/tables/{slug}", include_in_schema=False)
    def tables_page(slug: str) -> FileResponse:
        return FileResponse(static / "tables.html", headers={"Cache-Control": "no-cache"})

    @app.get("/time-entries", include_in_schema=False)
    def time_entries_page() -> FileResponse:
        return FileResponse(static / "time-entries.html", headers={"Cache-Control": "no-cache"})

    @app.get("/", include_in_schema=False)
    @app.get("/notes", include_in_schema=False)
    @app.get("/notes/{path:path}", include_in_schema=False)
    def spa(path: str = "") -> FileResponse:
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})

    return app

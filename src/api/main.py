"""FastAPI app factory."""
from __future__ import annotations

import logging
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from src.api.localhost import LocalhostOnly
from src.api.routes import agents, chat as chat_routes, diagrams, events, iptv as iptv_routes, notes, system
from src.api.routes import colab as colab_routes
from src.application.agents.quota import AgentQuota
from src.application.agents.refresh import RefreshSchedule
from src.application.agents.usage import AgentUsage
from src.application.colab.collector import ColabCollector
from src.application.chat.service import ChatService
from src.application.diagrams.service import DiagramError, DiagramService
from src.application.iptv.catalog import IptvCatalog
from src.infrastructure.iptv.store import IptvStore
from src.infrastructure.iptv.xtream import XtreamClient, XtreamConfig
from src.application.notes.service import NoteService
from src.domain.notes.errors import GitError, InvalidProperty, InvalidSlug, InvalidTime, InvalidTitle, NoteConflict, NoteExists, NoteLinked, NoteNotFound
from src.infrastructure.fs_notes.repository import FileNoteRepository
from src.infrastructure.agents.codex import CodexCommitMessages, codex_program
from src.infrastructure.agents.codex_chat import CodexChat
from src.infrastructure.agents.agy import AgyChat, AgyCommitMessages, agy_program
from src.infrastructure.agents.claude import ClaudeChat, ClaudeCommitMessages, claude_program
from src.infrastructure.agents.sessions import SessionStore
from src.domain.agents.quota import QuotaError, parse_snapshot
from src.infrastructure.agents.quota_sources import QuotaCollector
from src.infrastructure.agents.usage_files import CcusageCollector, ReportStore
from src.infrastructure.colab.cli import collect_colab_snapshot, get_colab_kernel_state, get_colab_sessions
from src.infrastructure.git.client import GitClient
from src.infrastructure.git.rewording import CommitRewriter
from src.infrastructure.metrics import Metrics
from src.infrastructure.system.monitor import ContainerMonitor
from src.infrastructure.watcher import NotesWatcher


class RevalidatedStatic(StaticFiles):
    """Static files that the browser checks with the server on every use (a cheap 304 when nothing changed). Without this a browser
    keeps an unchanged-for-a-while script for days, so a fix to it (the toast, say) is not seen until a hard refresh."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def codex_setting(feature: str, name: str, agent: str = "CODEX") -> str | None:
    """HIVE_<agent>_<feature>_<name> (agent CODEX, AGY or CLAUDE, feature COMMIT or CHAT), else HIVE_<agent>_<name>, else None (the
    agent's own default)."""
    return os.environ.get(f"HIVE_{agent}_{feature}_{name}") or os.environ.get(f"HIVE_{agent}_{name}") or None


def state_dir() -> Path:
    return Path(os.environ.get("HIVE_STATE_DIR") or "~/.local/state/hive").expanduser()


def codex_sessions() -> SessionStore:
    """The Codex session ids of the chat and of the commit messages (kept on the server)."""
    return SessionStore(state_dir() / "codex-sessions.json")


def commit_rewriter(git: GitClient, metrics: Metrics, root: Path | None = None) -> CommitRewriter | None:
    """HIVE_COMMIT_MESSAGES=codex or agy: after each save, that agent reads the diff and replaces "doc: update Title" with a
    message about the change. Off by default because the diff of the note is sent to the model."""
    agent = os.environ.get("HIVE_COMMIT_MESSAGES", "").strip().lower()
    if agent not in ("codex", "agy", "claude"):
        return None
    log = logging.getLogger("hive.commit_messages")
    sessions = codex_sessions() if root else None
    if agent == "claude":
        program = claude_program(os.environ.get("HIVE_CLAUDE"))
        if not program:
            log.warning("HIVE_COMMIT_MESSAGES=claude but claude was not found (set HIVE_CLAUDE)")
            return None
        writer = ClaudeCommitMessages(program, codex_setting("COMMIT", "MODEL", "CLAUDE"), effort=codex_setting("COMMIT", "EFFORT", "CLAUDE"), notes_dir=root, sessions=sessions)
    elif agent == "agy":
        program = agy_program(os.environ.get("HIVE_AGY"))
        if not program:
            log.warning("HIVE_COMMIT_MESSAGES=agy but agy was not found (set HIVE_AGY)")
            return None
        writer = AgyCommitMessages(program, codex_setting("COMMIT", "MODEL", "AGY"), effort=codex_setting("COMMIT", "EFFORT", "AGY"), notes_dir=root, sessions=sessions)
    else:
        program = codex_program(os.environ.get("HIVE_CODEX"))
        if not program:
            log.warning("HIVE_COMMIT_MESSAGES=codex but codex was not found (set HIVE_CODEX)")
            return None
        writer = CodexCommitMessages(program, codex_setting("COMMIT", "MODEL"), effort=codex_setting("COMMIT", "EFFORT"), notes_dir=root, sessions=sessions)
    return CommitRewriter(git, writer, metrics)


def chat_missing() -> str:
    """What the chat page says when the agent it is set to use was not found."""
    return {"agy": AgyChat, "claude": ClaudeChat}.get(os.environ.get("HIVE_CHAT_AGENT", "").strip().lower(), CodexChat).missing


def chat_codex(root: Path) -> CodexChat | None:
    """The chat runs Codex (HIVE_CODEX, else the one on PATH), Antigravity with HIVE_CHAT_AGENT=agy (HIVE_AGY) or Claude with HIVE_CHAT_AGENT=claude (HIVE_CLAUDE); without
    the program the chat page says so."""
    agent = os.environ.get("HIVE_CHAT_AGENT", "").strip().lower()
    if agent == "claude":
        program = claude_program(os.environ.get("HIVE_CLAUDE"))
        return ClaudeChat(program, root, codex_setting("CHAT", "MODEL", "CLAUDE"), codex_setting("CHAT", "EFFORT", "CLAUDE")) if program else None
    if agent == "agy":
        program = agy_program(os.environ.get("HIVE_AGY"))
        return AgyChat(program, root, codex_setting("CHAT", "MODEL", "AGY"), codex_setting("CHAT", "EFFORT", "AGY")) if program else None
    program = codex_program(os.environ.get("HIVE_CODEX"))
    return CodexChat(program, root, codex_setting("CHAT", "MODEL"), codex_setting("CHAT", "EFFORT")) if program else None


def create_app(notes_dir: str | Path | None = None, watch: bool | None = None,
               diagram_service: DiagramService | None = None, agent_usage: AgentUsage | None = None, agent_quota: AgentQuota | None = None, colab: ColabCollector | None = None, schedule: bool | None = None, chat_runner=None, iptv: IptvCatalog | None = None) -> FastAPI:
    load_dotenv()
    root = Path(notes_dir or os.environ.get("NOTES_DIR", "~/Workspace/notes")).expanduser().resolve()
    metrics = Metrics()
    git = GitClient(root, metrics)
    if not root.is_dir() or not git.is_repo():
        raise RuntimeError(f"NOTES_DIR {root} must be an existing git working tree")

    rewriter = commit_rewriter(git, metrics, root)
    service = NoteService(FileNoteRepository(root, git, after_commit=rewriter.submit if rewriter else None), metrics)
    if watch is None:
        watch = os.environ.get("HIVE_WATCH", "1") != "0"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        watcher = NotesWatcher(root, service.invalidate, metrics) if watch else None
        if watcher:
            watcher.start()
        if schedule:
            refresh_schedule.start()
        try:
            yield
        finally:
            refresh_schedule.stop()
            await app.state.colab.shutdown()  # stops the per-runtime collectors; nothing keeps probing after shutdown
            if watcher:
                watcher.stop()

    if schedule is None:  # the quarter-hour refresh belongs to the real collectors; tests that inject fakes drive them themselves
        schedule = agent_usage is None and agent_quota is None

    if diagram_service is None:
        diagram_service = DiagramService(
            java=os.environ.get("PLANTUML_JAVA") or shutil.which("java"),
            jar=os.environ.get("PLANTUML_JAR", "~/.local/share/hive/plantuml/plantuml.jar"),
            notes_dir=root, metrics=metrics)

    diagram_service.metrics = metrics  # one set of metrics for the whole app (/api/metrics)
    app = FastAPI(title="Hive Notes", lifespan=lifespan)
    app.add_middleware(LocalhostOnly)  # no login: only requests addressed to localhost are served
    app.state.notes = service
    app.state.diagrams = diagram_service
    app.state.metrics = metrics
    app.state.system = ContainerMonitor(root)
    agents_state = Path(os.environ.get("HIVE_STATE_DIR") or "~/.local/state/hive").expanduser() / "agents"
    if agent_usage is None:
        agent_usage = AgentUsage(ReportStore(agents_state / "usage.json"), CcusageCollector(os.environ.get("HIVE_CCUSAGE") or None))
    if agent_quota is None:
        agent_quota = AgentQuota(ReportStore(agents_state / "quota.json", parse_snapshot, (QuotaError,), "quota snapshot"), QuotaCollector())
    agent_usage.metrics = agent_quota.metrics = metrics  # one set of metrics for the whole app (/api/metrics)
    refresh_schedule = RefreshSchedule([agent_usage, agent_quota])
    app.state.agents = agent_usage
    app.state.agent_quota = agent_quota
    app.state.colab = colab or ColabCollector(sessions=get_colab_sessions, kernel_state=get_colab_kernel_state, collect=collect_colab_snapshot)
    def xtream_client() -> XtreamClient | None:  # the account is read from the environment each time
        config = XtreamConfig.from_env()
        return XtreamClient(config) if config else None

    app.state.iptv = iptv or IptvCatalog(IptvStore(state_dir() / "iptv.db"), xtream_client)
    app.state.chat = ChatService(chat_runner if chat_runner is not None else chat_codex(root), service, git, root, codex_sessions(), missing=chat_missing())

    def err(status: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            return JSONResponse({"detail": str(exc)}, status_code=status)
        return handler

    app.add_exception_handler(NoteNotFound, err(404))
    app.add_exception_handler(NoteExists, err(409))
    app.add_exception_handler(NoteConflict, err(412))
    app.add_exception_handler(NoteLinked, err(409))
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
    app.include_router(diagrams.embeds)  # /notes/{slug}/diagram.svg: before the note page's catch-all below
    app.include_router(system.router, prefix="/api")
    app.include_router(agents.router, prefix="/api")
    app.include_router(colab_routes.router, prefix="/api")
    app.include_router(chat_routes.router, prefix="/api")
    app.include_router(iptv_routes.router, prefix="/api")
    app.include_router(events.router, prefix="/api")

    @app.get("/api/metrics")
    def get_metrics() -> dict:
        return {**metrics.snapshot(), "watcher": bool(watch)}

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "notes_dir": str(root)}

    static = Path(__file__).resolve().parents[2] / "static"
    app.mount("/static", RevalidatedStatic(directory=static), name="static")

    @app.get("/tasks", include_in_schema=False)
    def tasks_page() -> FileResponse:
        return FileResponse(static / "tasks.html", headers={"Cache-Control": "no-cache"})

    # Note types read on their own page (keep in step with READ_PAGES in static/notes/read-pages.js).
    for prefix, html in (("tables", "tables.html"), ("timelines", "timelines.html"), ("specifications", "specifications.html"), ("tasks", "task-note.html")):
        def read_page(slug: str, html: str = html) -> FileResponse:
            return FileResponse(static / html, headers={"Cache-Control": "no-cache"})

        app.add_api_route(f"/{prefix}/{{slug}}", read_page, methods=["GET"], include_in_schema=False)

    @app.get("/dashboard", include_in_schema=False)
    @app.get("/dashboard/agents", include_in_schema=False)
    @app.get("/dashboard/colab", include_in_schema=False)
    def dashboard_page() -> FileResponse:
        return FileResponse(static / "dashboard.html", headers={"Cache-Control": "no-cache"})

    @app.get("/chat", include_in_schema=False)
    def chat_page() -> FileResponse:
        return FileResponse(static / "chat.html", headers={"Cache-Control": "no-cache"})

    @app.get("/time-entries", include_in_schema=False)
    def time_entries_page() -> FileResponse:
        return FileResponse(static / "time-entries.html", headers={"Cache-Control": "no-cache"})

    @app.get("/library", include_in_schema=False)
    def library_page() -> FileResponse:
        return FileResponse(static / "library.html", headers={"Cache-Control": "no-cache"})

    @app.get("/iptv", include_in_schema=False)  # the page's earlier address
    def iptv_page(request: Request) -> RedirectResponse:
        return RedirectResponse("/library" + (f"?{request.url.query}" if request.url.query else ""), status_code=301)

    @app.get("/", include_in_schema=False)
    @app.get("/notes", include_in_schema=False)
    @app.get("/notes/{path:path}", include_in_schema=False)
    def spa(path: str = "") -> FileResponse:
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})

    return app

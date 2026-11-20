"""Render PlantUML source to SVG with a local Java process (no server, no network).

Each render runs `java -jar plantuml.jar -pipe -tsvg` (about 200 ms), under PlantUML's SANDBOX security
profile: the renderer itself can read no files and open no URLs. `!include` / `!theme` of local files is
therefore resolved here first, from the notes folder and the bundled themes, and never outside them.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable

from src.domain.notes.errors import NoteError
from src.infrastructure.metrics import Metrics

MAX_SOURCE_LENGTH = 200_000  # characters; bounds what is parsed, sent to Java and cached
MAX_INCLUDE_DEPTH = 5
INCLUDE_SUFFIXES = {".puml", ".plantuml", ".pu", ".iuml", ".wsd"}
MONOKAI_NAMES = ("monokai-pro", "monokai_pro", "monokai", "monokai-theme")
MONOKAI_FILE = "puml-theme-monokai-pro.puml"
_INCLUDE = re.compile(r"^[ \t]*!include(?:_once)?[ \t]+(?P<target>[^\r\n]+?)[ \t]*$", re.MULTILINE | re.IGNORECASE)
_THEME = re.compile(r"^[ \t]*!theme[ \t]+(?P<name>[^\s]+)[^\r\n]*$", re.MULTILINE | re.IGNORECASE)

Runner = Callable[[list[str], bytes, dict, float], "subprocess.CompletedProcess[bytes]"]


class DiagramError(NoteError):
    """Base class: `status` is the HTTP status the API maps it to."""
    status = 500


class DiagramUnavailable(DiagramError):
    status = 503


class DiagramTooLarge(DiagramError):
    status = 413


class DiagramFailed(DiagramError):
    status = 502


def _default_runner(cmd: list[str], data: bytes, env: dict, timeout: float):
    return subprocess.run(cmd, input=data, capture_output=True, env=env, timeout=timeout)


class DiagramService:
    def __init__(self, java: str | None, jar: str | Path | None, notes_dir: Path, themes_dir: Path | None = None,
                 metrics: Metrics | None = None, runner: Runner = _default_runner, timeout: float = 30.0,
                 max_parallel: int = 2, cache_size: int = 128):
        self.java = java
        self.jar = Path(jar).expanduser() if jar else None
        self.notes_dir = Path(notes_dir)
        self.themes_dir = Path(themes_dir) if themes_dir else Path(__file__).resolve().parents[3] / "resources" / "plantuml" / "themes"
        self.metrics = metrics or Metrics()
        self._runner = runner
        self.timeout = timeout
        self._slots = threading.BoundedSemaphore(max_parallel)
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._cache_size = cache_size
        self._lock = threading.Lock()

    # -- availability ----------------------------------------------------
    def status(self) -> dict:
        problem = None
        if not self.java or not Path(self.java).is_file():
            problem = "Java was not found. Set PLANTUML_JAVA to the java executable."
        elif not self.jar or not self.jar.is_file():
            problem = f"plantuml.jar was not found at {self.jar}. Set PLANTUML_JAR."
        return {"available": problem is None, "reason": problem}

    # -- includes ---------------------------------------------------------
    @staticmethod
    def _contained(directory: Path, relative: str) -> Path | None:
        """The file `relative` names, only if it resolves inside `directory` (no `..`, absolute paths or escaping symlinks)."""
        try:
            root = directory.resolve()
            candidate = (root / relative).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return candidate
        except (OSError, ValueError):
            pass
        return None

    def _theme_text(self, name: str) -> str | None:
        name = name.strip().strip("\"'").lower()
        if name in MONOKAI_NAMES:
            f = self._contained(self.themes_dir, MONOKAI_FILE)
            return f.read_text(encoding="utf-8") if f else None
        return None

    def resolve_includes(self, source: str, _depth: int = 0, _seen: frozenset[Path] = frozenset()) -> str:
        """Inline `!include <file>` (from the notes folder) and the bundled `!theme monokai-pro`; leave the rest."""
        def theme(m: re.Match) -> str:
            text = self._theme_text(m["name"])
            return m[0] if text is None else text

        def include(m: re.Match) -> str:
            target = m["target"].strip().strip("<>\"'")
            if _depth >= MAX_INCLUDE_DEPTH or "://" in target or "!" in target:  # URLs, `file!index`, stdlib `<aws/x>`
                return m[0]
            if Path(target).stem.lower() in MONOKAI_NAMES:
                text = self._theme_text(Path(target).stem)
                if text is not None:
                    return text
            if Path(target).suffix.lower() not in INCLUDE_SUFFIXES:
                return m[0]
            f = self._contained(self.notes_dir, target)
            if f is None or f in _seen:
                return m[0]
            return self.resolve_includes(f.read_text(encoding="utf-8"), _depth + 1, _seen | {f})

        return _INCLUDE.sub(include, _THEME.sub(theme, source))

    # -- rendering --------------------------------------------------------
    def render(self, source: str) -> str:
        source = (source or "").strip()
        if not source:
            raise DiagramFailed("There is no diagram source to render.")
        if len(source) > MAX_SOURCE_LENGTH:
            raise DiagramTooLarge(f"Diagram source is too large: {len(source):,} characters (the limit is {MAX_SOURCE_LENGTH:,}).")
        st = self.status()
        if not st["available"]:
            raise DiagramUnavailable(st["reason"])
        resolved = self.resolve_includes(source)
        if len(resolved) > MAX_SOURCE_LENGTH * 2:
            raise DiagramTooLarge("Diagram source is too large once its includes are expanded.")
        key = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self.metrics.incr("diagram_cache_hits")
                return self._cache[key]
        self.metrics.incr("diagram_cache_misses")
        svg = self._run(resolved)
        with self._lock:
            self._cache[key] = svg
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return svg

    def _run(self, source: str) -> str:
        cmd = [self.java, "-Xmx512m", "-Djava.awt.headless=true", "-jar", str(self.jar), "-pipe", "-tsvg", "-charset", "UTF-8"]
        # SANDBOX: PlantUML itself may not read files or fetch URLs (includes were resolved above).
        env = {**os.environ, "PLANTUML_SECURITY_PROFILE": "SANDBOX"}
        with self._slots:
            try:
                with self.metrics.time("diagram_render"):
                    proc = self._runner(cmd, source.encode("utf-8"), env, self.timeout)
            except subprocess.TimeoutExpired:
                raise DiagramFailed(f"Rendering took longer than {self.timeout:g} seconds.") from None
            except OSError as exc:
                raise DiagramUnavailable(f"Could not start Java: {exc}") from None
        svg = proc.stdout.decode("utf-8", errors="replace")
        if "<svg" not in svg:
            detail = proc.stderr.decode("utf-8", errors="replace").strip()[:300]
            raise DiagramFailed(f"PlantUML produced no image. {detail}".strip())
        return svg[svg.index("<svg"):]

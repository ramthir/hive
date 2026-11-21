"""Render PlantUML source to SVG with a local Java process (no server, no network).

Each render runs `java -jar plantuml.jar -pipe -tsvg` (about 200 ms), under PlantUML's SANDBOX security
profile: the renderer itself can read no files and open no URLs. `!include` / `!theme` of local files is
therefore resolved here first, from the notes folder and the bundled themes, and never outside them.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
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

EXPORT_DPI = 300
DEFAULT_DPI = 96
SAFE_IMAGE_SIDE = 4000
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_START = re.compile(r"(^[ \t]*@start[a-z0-9_-]*[^\r\n]*)", re.MULTILINE | re.IGNORECASE)

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


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or not data.startswith(_PNG_SIGNATURE):
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _after_start(source: str, lines: str) -> str:
    if _START.search(source):
        return _START.sub(lambda m: m[1] + "\n" + lines, source, count=1)
    return lines + "\n" + source


def _with_dpi(source: str, dpi: int) -> str:
    return _after_start(source, f"skinparam dpi {dpi}")


def _for_export(source: str, theme: str) -> str:
    """Pandora's download tweaks: no frame around the image and, for `light`, the monokai theme's light palette."""
    if theme == "light" and not re.search(r"^[ \t]*!define[ \t]+THEME_LIGHT\b", source, re.MULTILINE | re.IGNORECASE):
        theme_line = re.search(r"^[ \t]*!(?:theme[ \t]+monokai[\w-]*|include[ \t]+.*monokai.*)$", source, re.MULTILINE | re.IGNORECASE)
        if theme_line:
            source = source[:theme_line.start()] + "!define THEME_LIGHT\n" + source[theme_line.start():]
        else:
            source = _after_start(source, "!define THEME_LIGHT\n!theme monokai-pro")
    if not re.search(r"^[ \t]*skinparam[ \t]+DiagramBorderColor\b", source, re.MULTILINE | re.IGNORECASE):
        source = _after_start(source, "skinparam DiagramBorderColor transparent\nskinparam DiagramBorderThickness 0")
    return source


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
        # Graphviz is optional: without it PlantUML still draws, but with a simpler layout that ignores a
        # theme's `LineType ortho` (connectors come out diagonal instead of boxed at right angles).
        graphviz = bool(shutil.which("dot") or os.environ.get("GRAPHVIZ_DOT"))
        return {"available": problem is None, "reason": problem, "graphviz": graphviz}

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
        # Graphviz changes the layout (ortho connectors), so a render made without it must not be reused once it is installed.
        key = hashlib.sha256((("dot:" if st["graphviz"] else "nodot:") + resolved).encode("utf-8")).hexdigest()
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

    def render_png(self, source: str, theme: str = "dark", dpi: int = EXPORT_DPI) -> bytes:
        """A high-resolution PNG for download. `theme` is `dark` (the bundled monokai look) or `light`."""
        source = (source or "").strip()
        if not source:
            raise DiagramFailed("There is no diagram source to render.")
        if len(source) > MAX_SOURCE_LENGTH:
            raise DiagramTooLarge(f"Diagram source is too large: {len(source):,} characters (the limit is {MAX_SOURCE_LENGTH:,}).")
        st = self.status()
        if not st["available"]:
            raise DiagramUnavailable(st["reason"])
        resolved = self.resolve_includes(_for_export(source, theme))
        if len(resolved) > MAX_SOURCE_LENGTH * 2:
            raise DiagramTooLarge("Diagram source is too large once its includes are expanded.")
        natural = self._run_bytes(resolved, "-tpng")
        size = _png_size(natural)
        if size is None or re.search(r"^\s*(?:skinparam\s+dpi|scale)\b", resolved, re.MULTILINE | re.IGNORECASE):
            return natural
        # PlantUML cuts an image off at about 4096 px a side: pick the highest dpi that still fits.
        dpi = min(dpi, DEFAULT_DPI * SAFE_IMAGE_SIDE // max(*size, 1))
        if dpi <= DEFAULT_DPI:
            return natural
        return self._run_bytes(_with_dpi(resolved, dpi), "-tpng")

    def _run(self, source: str) -> str:
        svg = self._run_bytes(source, "-tsvg").decode("utf-8", errors="replace")
        return svg[svg.index("<svg"):]

    def _run_bytes(self, source: str, fmt: str) -> bytes:
        cmd = [self.java, "-Xmx512m", "-Djava.awt.headless=true", "-jar", str(self.jar), "-pipe", fmt, "-charset", "UTF-8"]
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
        marker = b"\x89PNG" if fmt == "-tpng" else b"<svg"
        if marker not in proc.stdout:
            detail = proc.stderr.decode("utf-8", errors="replace").strip()[:300]
            raise DiagramFailed(f"PlantUML produced no image. {detail}".strip())
        return proc.stdout[proc.stdout.index(marker):]

"""Round-trip-safe YAML frontmatter: key order, quoting and body are preserved."""
from __future__ import annotations

import io
from typing import Any

from ruamel.yaml import YAML


def _yaml() -> YAML:
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 10_000
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def split(text: str) -> tuple[Any | None, str]:
    """Return (frontmatter map or None, body). Body excludes the one blank line after ``---``."""
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---\n", 3)
    if end < 0:
        return None, text
    try:
        meta = _yaml().load(text[4:end + 1])
    except Exception:
        return None, text
    if meta is None:
        meta = _yaml().load("{}")
    if not hasattr(meta, "items"):
        return None, text
    body = text[end + 5:]
    if body.startswith("\n"):
        body = body[1:]
    return meta, body


def render(meta: Any, body: str) -> str:
    buf = io.StringIO()
    _yaml().dump(meta, buf)
    return f"---\n{buf.getvalue()}---\n\n{body}" if body else f"---\n{buf.getvalue()}---\n"


def new_map() -> Any:
    return _yaml().load("{}")

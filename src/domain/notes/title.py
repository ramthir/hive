"""A note's title is the text of its first heading: the first non-blank line, `# Title`."""
from __future__ import annotations

import re

_H1 = re.compile(r"^#[ \t]+(.*?)[ \t]*#*[ \t]*$|^#[ \t]*$")


def _first_line_index(content: str) -> int | None:
    lines = (content or "").split("\n")
    for i, line in enumerate(lines):
        if line.strip():
            return i
    return None


def extract_h1(content: str) -> str | None:
    """Title text of the first non-blank line if it is a level-1 heading ('' for a bare `#`), else None."""
    lines = (content or "").split("\n")
    i = _first_line_index(content)
    if i is None:
        return None
    m = _H1.match(lines[i].rstrip("\r"))
    if not m:
        return None
    return (m.group(1) or "").strip()


def set_h1(content: str, title: str) -> str:
    """Make the first line `# title`: replace an existing H1, otherwise insert one above the content."""
    lines = (content or "").split("\n")
    i = _first_line_index(content)
    if i is not None and extract_h1(content) is not None:
        lines[i] = f"# {title}"
        return "\n".join(lines)
    body = (content or "").lstrip("\n")
    return f"# {title}\n\n{body}" if body.strip() else f"# {title}\n"


def with_h1(title: str, content: str) -> str:
    """The content, guaranteed to start with an H1 (inserting `# title` if it has none)."""
    return content if extract_h1(content) is not None else set_h1(content, title)

"""Find and rewrite ``[[target]]`` / ``[[target|label]]`` links, skipping code and escapes."""
from __future__ import annotations

import re
from typing import Callable

LINK = re.compile(r"\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")


def _scan(content: str, on_link: Callable[[re.Match], str] | None) -> tuple[list[str], str]:
    """Walk the text outside fenced/indented/inline code. Returns (targets, rewritten text)."""
    targets: list[str] = []
    out: list[str] = []
    fence: str | None = None
    for line in (content or "").splitlines(keepends=True):
        marker = FENCE.match(line)
        if fence:
            out.append(line)
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not line[marker.end():].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
            out.append(line)
            continue
        if line.startswith(("    ", "\t")):
            out.append(line)
            continue

        def sub(m: re.Match) -> str:
            if m.start() > 0 and line[m.start() - 1] == "\\":
                return m[0]
            targets.append(m[1].strip())
            return on_link(m) if on_link else m[0]

        # Replace links only in the text between inline-code spans.
        pieces, pos = [], 0
        for code in INLINE_CODE.finditer(line):
            pieces.append(LINK.sub(sub, line[pos:code.start()]))
            pieces.append(code[0])
            pos = code.end()
        pieces.append(LINK.sub(sub, line[pos:]))
        out.append("".join(pieces))
    return targets, "".join(out)


def extract_targets(content: str) -> list[str]:
    return _scan(content, None)[0]


def rewrite_targets(content: str, mapping: Callable[[str], str | None]) -> str:
    """Replace each link target using ``mapping(target)`` (None keeps it); labels are preserved."""

    def repl(m: re.Match) -> str:
        new = mapping(m[1].strip())
        if new is None:
            return m[0]
        return f"[[{new}|{m[2]}]]" if m[2] is not None else f"[[{new}]]"

    return _scan(content, repl)[1]

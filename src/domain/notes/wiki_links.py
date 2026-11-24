"""Find and rewrite ``[[target]]`` / ``[[target|label]]`` links, skipping code and escapes."""
from __future__ import annotations

import re
from typing import Callable

LINK = re.compile(r"\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]")
# `![alt](/notes/<slug>/diagram.svg?n=2)`: a diagram embed names its note by slug, so it counts as a link to that note.
EMBED = re.compile(r"(?<=\()/notes/([A-Za-z0-9._-]+)/diagram\.(?:svg|png)(?=[?)#\s])")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")


def _scan(content: str, on_link: Callable[[re.Match], str] | None, on_embed: Callable[[re.Match], str] | None = None) -> tuple[list[str], str]:
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

        def embed(m: re.Match) -> str:
            targets.append(m[1])
            return on_embed(m) if on_embed else m[0]

        def plain(text: str) -> str:
            return EMBED.sub(embed, LINK.sub(sub, text))

        # Replace links only in the text between inline-code spans.
        pieces, pos = [], 0
        for code in INLINE_CODE.finditer(line):
            pieces.append(plain(line[pos:code.start()]))
            pieces.append(code[0])
            pos = code.end()
        pieces.append(plain(line[pos:]))
        out.append("".join(pieces))
    return targets, "".join(out)


def extract_targets(content: str) -> list[str]:
    return _scan(content, None)[0]


def parse_link(value: str) -> tuple[str, str]:
    """For a wiki link ``[[target]]`` or ``[[target|label]]`` return ``(target, label)``; else ``(value, value)``."""
    text = (value or "").strip()
    m = LINK.fullmatch(text)
    if not m:
        return text, text
    target = m[1].strip()
    return target, (m[2] or target).strip()


def rewrite_targets(content: str, mapping: Callable[[str], str | None]) -> str:
    """Replace each link target using ``mapping(target)`` (None keeps it); labels are preserved."""

    def repl(m: re.Match) -> str:
        new = mapping(m[1].strip())
        if new is None:
            return m[0]
        return f"[[{new}|{m[2]}]]" if m[2] is not None else f"[[{new}]]"

    def repl_embed(m: re.Match) -> str:
        new = mapping(m[1])
        if new is None or not re.fullmatch(r"[A-Za-z0-9._-]+", new):  # a title is not a slug: only a slug fits the address
            return m[0]
        return m[0].replace(f"/notes/{m[1]}/", f"/notes/{new}/", 1)

    return _scan(content, repl, repl_embed)[1]

"""The PlantUML diagrams of a note: its fenced ```plantuml / ```puml blocks, in order (the `n` of `/notes/<slug>/diagram.svg?n=`)."""
from __future__ import annotations

import re

_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*(?:plantuml|puml)\b[^\r\n]*$", re.IGNORECASE)
_ANY_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def plantuml_blocks(content: str) -> list[str]:
    """The source of each plantuml fence, trimmed. An empty fence still counts, so `n` matches the diagrams the page shows."""
    blocks: list[str] = []
    fence: str | None = None  # the marker of the fence we are inside
    diagram = False
    body: list[str] = []
    for line in (content or "").splitlines():
        if fence is None:
            marker = _ANY_FENCE.match(line)
            if marker:
                fence = marker[1]
                diagram = bool(_OPEN.match(line))
                body = []
            continue
        marker = _ANY_FENCE.match(line)
        if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not line[marker.end():].strip():
            if diagram:
                blocks.append("\n".join(body).strip())
            fence, diagram = None, False
        elif diagram:
            body.append(line)
    return blocks

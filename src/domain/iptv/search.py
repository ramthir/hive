"""The Library search box: free words match the title, and `group:` matches the provider's category."""
from __future__ import annotations

import re
from dataclasses import dataclass

_GROUP = re.compile(r'\bgroup:(?:"([^"]*)"|(\S*))', re.IGNORECASE)


@dataclass(frozen=True)
class Query:
    words: tuple[str, ...] = ()  # each must be in the title
    groups: tuple[str, ...] = ()  # each must be in the category


def parse_query(text: str | None) -> Query:
    """`heat group:hollywood`, `group:"Tamil Movies"`. A `group:` with nothing after it is ignored; the rest is title words."""
    text = text or ""
    groups = tuple(g.strip().lower() for m in _GROUP.finditer(text) if (g := m.group(1) if m.group(1) is not None else m.group(2)).strip())
    rest = _GROUP.sub(" ", text)
    return Query(words=tuple(rest.lower().split()), groups=groups)

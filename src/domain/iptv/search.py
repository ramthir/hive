"""The Library search box: free words match the title, `group:` matches the provider's category and `is:starred` keeps the starred ones."""
from __future__ import annotations

import re
from dataclasses import dataclass

_GROUP = re.compile(r'\bgroup:(?:"([^"]*)"|(\S*))', re.IGNORECASE)
_STARRED = re.compile(r"(?<!\S)is:star(?:red)?(?!\S)", re.IGNORECASE)


@dataclass(frozen=True)
class Query:
    words: tuple[str, ...] = ()  # each must be in the title
    groups: tuple[str, ...] = ()  # each must be in the category
    starred: bool = False  # only the ones the user starred


def parse_query(text: str | None) -> Query:
    """`heat group:hollywood`, `group:"Tamil Movies"`, `is:starred raja`. A `group:` with nothing after it is ignored; the rest is title words."""
    text = text or ""
    groups = tuple(g.strip().lower() for m in _GROUP.finditer(text) if (g := m.group(1) if m.group(1) is not None else m.group(2)).strip())
    rest = _GROUP.sub(" ", text)
    starred = bool(_STARRED.search(rest))
    rest = _STARRED.sub(" ", rest)
    return Query(words=tuple(rest.lower().split()), groups=groups, starred=starred)

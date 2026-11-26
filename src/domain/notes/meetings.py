"""Domain helpers for meeting and meeting-minutes notes."""
from __future__ import annotations

import re
from dataclasses import dataclass

_FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
_H2 = re.compile(r"^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?\s*$")
_ACTION_ITEM = re.compile(r"^ ?(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\](?=\s|$))?")


@dataclass(frozen=True)
class ActionSummary:
    done: int
    total: int

    @property
    def pending(self) -> int:
        return self.total - self.done


def _section_key(name: str) -> str:
    cleaned = "".join(ch for ch in name if ch.isalnum() or ch.isspace())
    return " ".join(cleaned.split()).casefold()


def count_action_items(content: str) -> ActionSummary:
    """Count top-level list items (done and total) under ``## Action Items`` sections outside code fences."""
    done = 0
    total = 0
    in_actions = False
    fence = ""
    for line in content.splitlines():
        marker = _FENCE.match(line)
        opens = marker and (marker.group(1)[0] == "~" or "`" not in marker.group(2))
        plain = not fence and not opens
        if not fence and opens:
            fence = marker.group(1)
        elif fence and marker and marker.group(1).startswith(fence) and not marker.group(2).strip():
            fence = ""
        if not plain:
            continue
        heading = _H2.match(line)
        if heading:
            in_actions = _section_key(heading.group(1)) == "action items"
            continue
        if in_actions:
            item = _ACTION_ITEM.match(line)
            if item:
                total += 1
                if item.group(1) and item.group(1) != " ":
                    done += 1
    return ActionSummary(done=done, total=total)

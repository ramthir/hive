"""Remembers Codex session ids on the server (a small JSON file in HIVE_STATE_DIR), so the chat and the commit
messages carry on in the same session whatever browser asks and across restarts."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

UUID = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")


class SessionStore:
    def __init__(self, path: Path):
        self.path, self._lock = Path(path), threading.Lock()

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self, name: str) -> str | None:
        value = self._read().get(name)
        return value if isinstance(value, str) and UUID.match(value) else None

    def tag(self, name: str) -> str | None:
        """A label saved with the session (the commit messages use the month it started in)."""
        value = self._read().get(f"{name}.tag")
        return value if isinstance(value, str) else None

    def set(self, name: str, session: str | None, tag: str | None = None) -> None:
        with self._lock:
            data = self._read()
            data.pop(f"{name}.tag", None)
            if session and UUID.match(session):
                data[name] = session
                if tag:
                    data[f"{name}.tag"] = tag
            else:
                data.pop(name, None)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self.path)

    def clear(self, name: str) -> None:
        self.set(name, None)

"""The IPTV catalogue in SQLite (a file in HIVE_STATE_DIR, separate from the notes). One connection per call, so threads never share one."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from src.domain.iptv.entities import Channel, StreamType
from src.domain.iptv.search import parse_query

SORTS = {"name": "name_lc, id", "latest": "added IS NULL, added DESC, name_lc", "oldest": "added IS NULL, added, name_lc"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS channel (
  type TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL, grp TEXT NOT NULL,
  logo TEXT, ext TEXT, added INTEGER, PRIMARY KEY (type, id));
CREATE INDEX IF NOT EXISTS channel_group ON channel (type, grp);
CREATE INDEX IF NOT EXISTS channel_name ON channel (type, name_lc);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def _like(word: str) -> str:
    return "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


class IptvStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.executescript(SCHEMA)
        return db

    def replace(self, type: StreamType, channels: list[Channel], synced_at: str) -> None:
        """Swap one kind's rows for the fetched ones in a single transaction (readers see the old or the new catalogue, never half)."""
        with closing(self._connect()) as db, db:
            db.execute("DELETE FROM channel WHERE type = ?", (type.value,))
            db.executemany(
                "INSERT OR REPLACE INTO channel VALUES (?,?,?,?,?,?,?,?)",
                [(type.value, c.id, c.name, c.name.lower(), c.group, c.logo, c.ext, c.added) for c in channels],
            )
            db.execute("INSERT OR REPLACE INTO meta VALUES ('synced_at', ?)", (synced_at,))

    def counts(self) -> dict[str, int]:
        with closing(self._connect()) as db:
            rows = db.execute("SELECT type, COUNT(*) n FROM channel GROUP BY type").fetchall()
        return {t.value: next((r["n"] for r in rows if r["type"] == t.value), 0) for t in StreamType}

    def synced_at(self) -> str | None:
        with closing(self._connect()) as db:
            row = db.execute("SELECT value FROM meta WHERE key = 'synced_at'").fetchone()
        return row["value"] if row else None

    def page(self, type: StreamType, group: str | None, q: str | None, sort: str, page: int, page_size: int) -> tuple[list[Channel], int]:
        where, args = ["type = ?"], [type.value]
        if group:
            where.append("grp = ?")
            args.append(group)
        query = parse_query(q)
        for word in query.words:
            where.append("name_lc LIKE ? ESCAPE '\\'")
            args.append(_like(word))
        for part in query.groups:  # the category contains it, whatever its case
            where.append("LOWER(grp) LIKE ? ESCAPE '\\'")
            args.append(_like(part))
        clause = " AND ".join(where)
        with closing(self._connect()) as db:
            total = db.execute(f"SELECT COUNT(*) FROM channel WHERE {clause}", args).fetchone()[0]
            rows = db.execute(
                f"SELECT * FROM channel WHERE {clause} ORDER BY {SORTS.get(sort, SORTS['name'])} LIMIT ? OFFSET ?",
                [*args, page_size, page * page_size],
            ).fetchall()
        return [self._channel(r) for r in rows], total

    def groups(self, type: StreamType) -> list[dict]:
        with closing(self._connect()) as db:
            rows = db.execute("SELECT grp, COUNT(*) n FROM channel WHERE type = ? GROUP BY grp ORDER BY grp COLLATE NOCASE", (type.value,)).fetchall()
        return [{"name": r["grp"], "count": r["n"]} for r in rows]

    def get(self, type: StreamType, provider_id: str) -> Channel | None:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM channel WHERE type = ? AND id = ?", (type.value, provider_id)).fetchone()
        return self._channel(row) if row else None

    @staticmethod
    def _channel(r: sqlite3.Row) -> Channel:
        return Channel(r["id"], StreamType(r["type"]), r["name"], r["grp"], r["logo"], r["ext"], r["added"])

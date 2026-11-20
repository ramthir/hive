"""Thin wrapper around the ``git`` CLI for a single working tree."""
from __future__ import annotations

import os
import subprocess
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from src.domain.notes.errors import GitError
from src.infrastructure.metrics import Metrics

_REC = "\x1e"
_SEP = "\x1f"


@dataclass(frozen=True)
class Commit:
    sha: str
    author: str
    committed_at: datetime
    message: str
    path: str  # path of the file as of this commit (differs from today's after renames)


class GitClient:
    def __init__(self, root: Path, metrics: Metrics | None = None):
        self.root = Path(root)
        self.metrics = metrics or Metrics()
        self._lock = threading.RLock()

    @property
    def lock(self) -> threading.RLock:
        """Hold around any multi-step write+commit sequence."""
        return self._lock

    def run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        proc = subprocess.run(
            ["git", "-C", str(self.root), *args],
            capture_output=True, text=True, env=env, encoding="utf-8",
        )
        if check and proc.returncode != 0:
            raise GitError(f"git {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()}")
        return proc

    def is_repo(self) -> bool:
        return self.run("rev-parse", "--is-inside-work-tree", check=False).returncode == 0

    def commit_paths(self, paths: list[str], message: str) -> str | None:
        """Stage and commit only ``paths`` (additions, edits, deletions); unrelated
        staged or dirty files are left alone. Returns the sha, or None if nothing changed."""
        with self._lock:
            present = [p for p in paths if (self.root / p).exists()]
            gone = [p for p in paths if p not in present]
            if present:
                self.run("add", "-A", "--", *present)
            if gone:
                self.run("rm", "-q", "--cached", "--ignore-unmatch", "--", *gone)
            if self.run("diff", "--cached", "--quiet", "--", *paths, check=False).returncode == 0:
                return None
            with self.metrics.time("git_commit"):  # includes pre-commit hooks
                self.run("commit", "-m", message, "--only", "--", *paths)
            # `commit --only` runs hooks against a temporary index, so a hook's own `git add` (e.g. a
            # formatter re-staging its output) never reaches the real index and would leave a phantom
            # staged change. Re-sync the real index with HEAD for just the paths we committed.
            self.run("reset", "-q", "HEAD", "--", *paths, check=False)
            return self.run("rev-parse", "HEAD").stdout.strip()

    def log(self, path: str) -> list[Commit]:
        out = self.run(
            "log", "--follow", "--name-only",
            f"--format={_REC}%H{_SEP}%an{_SEP}%aI{_SEP}%s", "--", path,
        ).stdout
        commits = []
        for rec in out.split(_REC):
            if not rec.strip():
                continue
            head, _, files = rec.partition("\n")
            sha, author, date, subject = head.split(_SEP, 3)
            name = next((f for f in files.splitlines() if f.strip()), path)
            commits.append(Commit(sha, author, datetime.fromisoformat(date), subject, name))
        return commits

    def show(self, sha: str, path: str) -> str:
        return self.run("show", f"{sha}:{path}").stdout

    def mv(self, old: str, new: str) -> None:
        self.run("mv", "--", old, new)

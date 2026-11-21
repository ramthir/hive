"""Where the agent usage report comes from: the ccusage program, and the file its output is kept in."""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from src.domain.agents.usage import SCHEMA_VERSION, CollectError, ReportError, parse_envelope

# Version managers whose node (and so ccusage) is not on the PATH of a service started without a login shell.
NODE_BIN_GLOBS = ("~/.nvm/versions/node/*/bin", "~/.local/share/mise/installs/node/*/bin")


def host_timezone() -> str:
    """IANA name of the host timezone, UTC when it cannot be determined."""
    candidates = [os.environ.get("TZ", "")]
    try:
        candidates.append(Path("/etc/timezone").read_text().strip())
    except OSError:
        pass
    try:
        candidates.append("/".join(Path("/etc/localtime").resolve().parts[-2:]))
    except OSError:
        pass
    for name in candidates:
        try:
            ZoneInfo(name)
            return name
        except Exception:  # unknown or empty name: try the next candidate
            continue
    return "UTC"


def find_ccusage(binary: str | None = None) -> str | None:
    """The ccusage to run: a path as given, else the PATH, else the newest one a node version manager installed."""
    binary = binary or "ccusage"
    if os.sep in binary:
        return binary
    found = shutil.which(binary)
    if found:
        return found
    candidates = [path for pattern in NODE_BIN_GLOBS for path in glob.glob(os.path.join(os.path.expanduser(pattern), binary))]
    return max(candidates, key=os.path.getmtime) if candidates else None


class CcusageCollector:
    """Runs `ccusage` for the current month. It reads the agents' own session logs, so there is nothing to configure."""

    def __init__(self, binary: str | None = None, timeout: int = 120, run=subprocess.run, tz_name: str | None = None):
        self.binary = binary
        self.timeout = timeout
        self.run = run
        self.tz_name = tz_name

    def collect(self, now: datetime) -> dict:
        """The envelope `parse_envelope` accepts: ccusage's JSON with when, since and in which timezone it was made."""
        program = find_ccusage(self.binary)
        if program is None:
            raise CollectError("ccusage was not found: install it (npm i -g ccusage), put it on PATH, or set HIVE_CCUSAGE.")
        tz_name = self.tz_name or host_timezone()
        since = now.astimezone(ZoneInfo(tz_name)).replace(day=1).strftime("%Y-%m-%d")
        command = [program, "--sections", "daily,session", "--by-agent", "--json", "--no-cost", "--offline",
                   "--since", since.replace("-", ""), "-z", tz_name]
        # ccusage is `#!/usr/bin/env node`: put its own folder first so it finds the node it was installed with.
        env = {**os.environ, "PATH": os.pathsep.join([os.path.dirname(program), os.environ.get("PATH", "")])} if os.sep in program else None
        try:
            result = self.run(command, capture_output=True, text=True, timeout=self.timeout, check=False, env=env)
        except subprocess.TimeoutExpired as exc:
            raise CollectError(f"ccusage did not finish in {self.timeout} s.") from exc
        except OSError as exc:
            raise CollectError(f"ccusage could not be started: {exc.strerror or exc}.") from exc
        if result.returncode != 0:
            raise CollectError(f"ccusage exited {result.returncode}: {result.stderr.strip()[:300]}")
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise CollectError(f"ccusage did not print JSON: {exc}") from exc
        return {"schema_version": SCHEMA_VERSION, "generated_at": now.isoformat(), "since": since, "timezone": tz_name, "report": report}


class ReportStore:
    """The report file. It is parsed again only when its size or modification time changed; a write replaces it atomically."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._signature = None
        self._envelope = None
        self._error = None
        self.parses = 0

    def load(self):
        """(envelope, error): the parsed report, or None and why there is none."""
        with self._lock:
            try:
                stat = self.path.stat()
            except FileNotFoundError:
                self._signature = self._envelope = None
                return None, "No usage report has been generated yet."
            except OSError as exc:
                self._signature = self._envelope = None
                return None, f"The usage report cannot be read: {exc.strerror or exc}."
            signature = (stat.st_mtime_ns, stat.st_size)
            if signature != self._signature:
                self.parses += 1
                self._signature = signature
                self._envelope = self._error = None
                try:
                    self._envelope = parse_envelope(json.loads(self.path.read_text()))
                except (OSError, json.JSONDecodeError) as exc:
                    self._error = f"The usage report cannot be read: {exc}."
                except ReportError as exc:
                    self._error = f"The usage report is invalid: {exc}"
            return self._envelope, self._error

    def save(self, raw: dict) -> None:
        """Replace the file with `raw`; a failed write leaves the last good report in place."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=self.path.parent, prefix=".usage-", suffix=".tmp")
        try:
            with os.fdopen(handle, "w") as stream:
                json.dump(raw, stream)
            os.replace(temp, self.path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise

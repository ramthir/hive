"""Where the 5-hour and weekly quota figures come from: each agent's own CLI. Nothing reads a login token or calls a
provider API itself; the CLI does, as it would for you.

| Agent | Source |
| Claude | `claude -p /usage` (no session is saved, no tokens used) |
| Codex | `codex app-server` over stdio JSON-RPC (`account/rateLimits/read`), else the newest `rate_limits` event in ~/.codex/sessions |
| Antigravity | `agy -p /usage` |

A provider whose source fails is `unavailable` with a reason, and its earlier values are not carried forward; a window whose
reset has passed is `expired` with no value. The three are read at the same time.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from src.domain.agents.quota import PROVIDERS, SCHEMA_VERSION
from src.infrastructure.agents.usage_files import NODE_BIN_GLOBS

WINDOWS = {300: "5h", 10080: "7d"}  # window length in minutes
CODEX_SCAN_FILES = 50  # newest session files searched for a rate-limit event
USAGE_LINE = re.compile(r"^(Current session|Current week \(all models\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$", re.M)
USAGE_WINDOWS = {"Current session": "5h", "Current week (all models)": "7d"}
AGY_LINE = re.compile(r"^(?P<pool>[^\t]+)\t(?P<metric>Five Hour Limit Remaining|Weekly Limit Remaining)\t(?P<remaining>\d+(?:\.\d+)?)%\t(?P<reset>\S+)$", re.M)
AGY_ARGON = re.compile(r"^Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t(?P<remaining>\d+(?:\.\d+)?)%\t(?P<reset>\S+)$", re.M)
# The windows shown for Antigravity: Gemini's two pools and Argon's weekly limit. The Claude and GPT pool is not shown.
AGY_WINDOWS = {("Gemini Models", "Five Hour Limit Remaining"): "5h", ("Gemini Models", "Weekly Limit Remaining"): "7d"}
USAGE_RESET = re.compile(r"^(\w{3} \d{1,2}), (\d{1,2}(?::\d{2})?(?:am|pm)) \((.+)\)$")


class CliError(RuntimeError):
    """A CLI's /usage call failed; the message is the reason shown for the provider."""


def find_program(name: str, env_name: str) -> str:
    """The program to run: $env_name, else PATH, else ~/.local/bin, else a node version manager's bin folder."""
    if os.environ.get(env_name):
        return os.environ[env_name]
    found = shutil.which(name)
    if found:
        return found
    for folder in [Path.home() / ".local/bin", *(Path(p) for pattern in NODE_BIN_GLOBS for p in sorted(Path("/").glob(os.path.expanduser(pattern).lstrip("/"))))]:
        if (folder / name).is_file():
            return str(folder / name)
    return name


# --- Parsing (text and JSON in, windows out; no processes) ------------------------------------------------------------

def parse_claude_usage(text: str, now: datetime) -> dict:
    """Windows from the text `claude -p /usage` prints; a reset is local to the zone it names."""
    windows = {}
    for label, used, reset in USAGE_LINE.findall(text):
        resets_at = None
        if reset:
            match = USAGE_RESET.match(reset)
            if not match:
                continue
            try:
                zone = ZoneInfo(match.group(3))
                clock = match.group(2)  # Claude drops the minutes on the hour: '11am' as well as '9:30pm'
                moment = datetime.strptime(f"{now.year} {match.group(1)} {clock}", "%Y %b %d %I:%M%p" if ":" in clock else "%Y %b %d %I%p")
            except (ValueError, KeyError):
                continue
            moment = moment.replace(tzinfo=zone)
            if moment < now - timedelta(days=60):
                moment = moment.replace(year=now.year + 1)  # a December reset read in January
            resets_at = moment.astimezone(timezone.utc).isoformat()
        windows[USAGE_WINDOWS[label]] = {"used_pct": float(used), "resets_at": resets_at, "collected_at": now.isoformat()}
    return windows


def _agy_window(used_pct: float, reset: str, now: datetime, pool: str):
    try:
        resets = datetime.fromisoformat(reset.replace("Z", "+00:00"))
    except ValueError:
        return None
    return {"used_pct": used_pct, "resets_at": resets.astimezone(timezone.utc).isoformat(), "collected_at": now.isoformat(), "pool": pool}


def parse_agy_usage(text: str, now: datetime) -> dict:
    """Windows from `agy -p /usage`: Gemini's 5-hour and weekly remaining allowance (as used %), and Argon's weekly one."""
    windows = {}
    for match in AGY_LINE.finditer(text):
        pool = match.group("pool").strip()
        name = AGY_WINDOWS.get((pool, match.group("metric")))
        window = name and _agy_window(100.0 - float(match.group("remaining")), match.group("reset"), now, pool)
        if window:
            windows[name] = window
    argon = AGY_ARGON.search(text)
    window = argon and _agy_window(100.0 - float(argon.group("remaining")), argon.group("reset"), now, "Gemini 4 Argon")
    if window:
        windows["argon-7d"] = window
    return windows


def _codex_windows(limits: dict, minutes_key: str, used_key: str, reset_key: str, now: datetime, measured: str | None) -> dict:
    windows = {}
    for key in ("primary", "secondary"):
        window = limits.get(key)
        name = WINDOWS.get(window.get(minutes_key)) if isinstance(window, dict) else None
        if name and isinstance(window.get(used_key), (int, float)) and isinstance(window.get(reset_key), int):
            resets = datetime.fromtimestamp(window[reset_key], timezone.utc)
            windows[name] = {"used_pct": float(window[used_key]), "resets_at": resets.isoformat(), "collected_at": measured}
    return windows


def parse_codex_rpc(result: dict, now: datetime) -> dict:
    """Windows from the app server's `account/rateLimits/read` answer."""
    limits = (result.get("rateLimitsByLimitId") or {}).get("codex") or result.get("rateLimits") or {}
    return _codex_windows(limits, "windowDurationMins", "usedPercent", "resetsAt", now, now.isoformat())


def codex_log_windows(sessions: Path, now: datetime):
    """Windows from the newest `rate_limits` event in Codex's session logs; (windows, reason)."""
    if not sessions.is_dir():
        return {}, "No Codex session logs found."
    for path in sorted(sessions.rglob("*.jsonl"), reverse=True)[:CODEX_SCAN_FILES]:
        last = None
        try:
            with path.open(encoding="utf-8", errors="replace") as lines:
                for line in lines:
                    if '"rate_limits"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    limits = (event.get("payload") or {}).get("rate_limits")
                    if isinstance(limits, dict):
                        last = (event.get("timestamp"), limits)
        except OSError:
            continue
        if last:
            return _codex_windows(last[1], "window_minutes", "used_percent", "resets_at", now, last[0]), None
    return {}, "No Codex rate-limit event found in recent session logs."


# --- Running the CLIs --------------------------------------------------------------------------------------------------

def run_cli_json(binary: str, name: str, args: list[str], text_key: str, failed, timeout: int = 120) -> str:
    """Run `<cli> <args> --output-format json` and return the text of its answer. `failed(reply)` says whether the CLI
    reported an error, so a failed call is named as such instead of looking like a reply with no windows."""
    try:
        result = subprocess.run([binary, *args, "--output-format", "json"], capture_output=True, text=True, timeout=timeout,
                                check=True, cwd=str(Path.home()))
    except (OSError, subprocess.SubprocessError):
        raise CliError(f"{name} did not finish /usage.") from None
    try:
        reply = json.loads(result.stdout)
    except ValueError:
        raise CliError(f"{name} printed no JSON for /usage.") from None
    if not isinstance(reply, dict):
        raise CliError(f"{name} printed an unexpected reply for /usage.")
    if failed(reply):
        raise CliError(f"{name} reported an error for /usage: {str(reply.get(text_key) or 'no detail')[:120]}")
    return str(reply.get(text_key) or "")


def run_claude_usage() -> str:
    # --no-session-persistence: the call leaves no session behind, so it never shows up on the Sessions table.
    return run_cli_json(find_program("claude", "CLAUDE_BIN"), "claude", ["-p", "/usage", "--no-session-persistence"], "result",
                        lambda reply: bool(reply.get("is_error")))


def run_agy_usage() -> str:
    return run_cli_json(find_program("agy", "AGY_BIN"), "agy", ["-p", "/usage", "--print-timeout", "60s"], "response",
                        lambda reply: reply.get("status") != "SUCCESS")


def run_codex_rpc(method: str, timeout: int = 60) -> dict:
    """Ask Codex's app server for one reply over its stdio JSON-RPC; no model turn is started."""
    process = subprocess.Popen([find_program("codex", "CODEX_BIN"), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, cwd=str(Path.home()))
    watchdog = threading.Timer(timeout, process.kill)  # a server that never answers must not hold the refresh
    watchdog.start()
    try:
        def send(message):
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()

        def reply(request_id):
            for line in process.stdout:
                message = json.loads(line)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(str(message["error"])[:200])
                    return message["result"]
            raise RuntimeError("Codex app server closed before replying")

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "hive-quota", "version": "1"}}})
        reply(1)
        send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        send({"jsonrpc": "2.0", "id": 2, "method": method, "params": None})
        return reply(2)
    finally:
        watchdog.cancel()
        process.kill()
        process.stdin.close()
        process.stdout.close()
        process.wait()


# --- The snapshot ------------------------------------------------------------------------------------------------------

def provider_entry(now: datetime, windows: dict, reason: str | None) -> dict:
    """A provider's entry from its readings; a window whose reset has passed is expired, with no value."""
    if not windows:
        return {"status": "unavailable", "reason": reason, "windows": {}}
    entries = {}
    for name, entry in windows.items():
        expired = entry["resets_at"] is not None and datetime.fromisoformat(entry["resets_at"]) <= now
        entries[name] = {"status": "expired" if expired else "ok", "used_pct": None if expired else entry["used_pct"],
                         "resets_at": entry["resets_at"], "collected_at": entry["collected_at"]}
        if entry.get("pool"):
            entries[name]["pool"] = entry["pool"]
    return {"status": "ok", "reason": None, "windows": entries}


def cli_windows(name: str, runner, parse, now: datetime):
    """(windows, reason) from one CLI's /usage text."""
    try:
        text = runner()
    except CliError as error:
        return {}, str(error)
    except (OSError, subprocess.SubprocessError):
        return {}, f"{name} could not run /usage."
    windows = parse(text, now)
    return (windows, None) if windows else ({}, f"{name} /usage printed no quota windows.")


def codex_windows(now: datetime, rpc, sessions: Path):
    """(windows, reason): the live app server, and only if it fails the session logs."""
    try:
        windows = parse_codex_rpc(rpc("account/rateLimits/read"), now)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        windows = {}
    return (windows, None) if windows else codex_log_windows(sessions, now)


class QuotaCollector:
    """Reads the three agents' quota at the same time and makes the snapshot `parse_snapshot` accepts. A failing agent is
    `unavailable` in it, never an exception, so one broken CLI does not hide the others."""

    def __init__(self, claude=None, agy=None, codex_rpc=None, codex_sessions: Path | None = None):
        self.claude = claude or run_claude_usage
        self.agy = agy or run_agy_usage
        self.codex_rpc = codex_rpc or run_codex_rpc
        self.codex_sessions = Path(codex_sessions or os.environ.get("CODEX_SESSIONS") or "~/.codex/sessions").expanduser()

    def collect(self, now: datetime) -> dict:
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="quota") as pool:
            readings = {
                "claude": pool.submit(cli_windows, "Claude Code", self.claude, parse_claude_usage, now),
                "antigravity": pool.submit(cli_windows, "Antigravity", self.agy, parse_agy_usage, now),
                "codex": pool.submit(codex_windows, now, self.codex_rpc, self.codex_sessions),
            }
            providers = {name: provider_entry(now, *readings[name].result()) for name in PROVIDERS}
        return {"schema_version": SCHEMA_VERSION, "generated_at": now.isoformat(), "providers": providers}

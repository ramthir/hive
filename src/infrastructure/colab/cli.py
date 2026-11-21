"""Run the local `colab` CLI and the fixed status probes inside a runtime, for the dashboard's Colab tab."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from src.domain.colab.errors import ColabBusyError, ColabCliError
from src.domain.colab.parsing import parse_processes_output, parse_sessions_output, parse_stats_output, parse_usage_output, validate_session_name

logger = logging.getLogger(__name__)


_REMOTE_STATS_CMD = (
    'echo "===CORES==="; nproc; '
    'echo "===UPTIME==="; uptime; '
    'echo "===CPU==="; top -bn1 | grep "Cpu(s)"; '
    'echo "===MEM==="; free -m; '
    'echo "===DISK==="; df -BM /content; '
    'echo "===GPU==="; nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total '
    "--format=csv,noheader,nounits 2>/dev/null || true"
)


_REMOTE_PROCESSES_CMD = "ps -eo pid,pcpu,pmem,rss,etime,comm,args --sort=-pcpu"


_probe_locks: dict[str, asyncio.Lock] = {}


def _get_probe_lock(session: str) -> asyncio.Lock:
    lock = _probe_locks.get(session)
    if lock is None:
        lock = asyncio.Lock()
        _probe_locks[session] = lock
    return lock


def _resolve_colab_bin() -> str:
    """Resolve the `colab` binary, checking ~/.local/bin when systemd PATH omits it."""
    if override := os.environ.get("COLAB_CLI_BIN"):
        return override
    if found := shutil.which("colab"):
        return found
    local_bin = Path.home() / ".local" / "bin" / "colab"
    if local_bin.is_file() and os.access(local_bin, os.X_OK):
        return str(local_bin)
    return "colab"


SIGN_IN_MESSAGE = "The colab CLI is not signed in. Run `colab usage` in a terminal once and finish the Google sign-in."
_SIGN_IN_MARKERS = ("To authorize colab-cli", "Enter the authorization code")


def _asks_to_sign_in(*outputs: str) -> bool:
    """The CLI starts an interactive Google sign-in when it has no token; Hive never answers it (stdin is closed)."""
    return any(marker in text for text in outputs for marker in _SIGN_IN_MARKERS)


def _readable(detail: str, limit: int = 300) -> str:
    """A CLI's error text for the page: no links (sign-in and API URLs carry client ids and state), on one line, cut short."""
    text = re.sub(r"https?://\S+", "<link>", " ".join(detail.split()))
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def run_colab_command(
    args: list[str], timeout: float = 15.0, *, input_text: str | None = None
) -> str:
    """Execute `colab <args>` without shell interpolation and return stdout."""
    try:
        proc = await asyncio.create_subprocess_exec(
            _resolve_colab_bin(),
            *args,
            stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise ColabCliError("colab CLI is not installed or not on PATH") from exc

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(input_text.encode("utf-8")) if input_text is not None else proc.communicate(),
            timeout=timeout
        )
    except asyncio.TimeoutError as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        hint = "; the notebook kernel may be busy. Try refreshing later." if args[0] == "exec" else ""
        raise ColabCliError(f"colab {args[0]} timed out{hint}") from exc
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()
    if _asks_to_sign_in(stdout, stderr):
        raise ColabCliError(SIGN_IN_MESSAGE)
    if proc.returncode != 0:
        detail = stderr or stdout.strip() or f"exit code {proc.returncode}"
        if "HTTP 429" in detail:
            raise ColabBusyError(detail)
        raise ColabCliError(f"colab {args[0]} failed: {_readable(detail)}")
    return stdout


async def get_colab_usage() -> dict[str, Any]:
    """Run `colab usage` and return parsed usage metrics."""
    stdout = await run_colab_command(["usage"])
    return parse_usage_output(stdout)


async def get_colab_sessions() -> list[dict[str, str]]:
    """Run `colab sessions` and return parsed active sessions."""
    stdout = await run_colab_command(["sessions"])
    return parse_sessions_output(stdout)


# One application worker owns these bindings and creation attempts. A failed or
# cancelled POST is not repeated: the remote outcome may be uncertain.
_kernel_start_attempts: set[str] = set()
_kernel_bindings: dict[str, dict[str, Any]] = {}


_PROBE_START = "===HIVE_PROBE_START==="
_PROBE_END = "===HIVE_PROBE_END==="


async def _run_exec_probe(session: str, command: str) -> str:
    """Run a fixed read-only probe in isolated kernel globals, with no SSH connection."""
    validate_session_name(session)
    lock = _get_probe_lock(session)
    # There is no await between this check and acquiring the available asyncio lock.
    if lock.locked():
        raise ColabBusyError("A Colab status probe is already running; waiting for next refresh.")
    async with lock:
        script = (
            "import subprocess\n"
            f"result = subprocess.run(['sh', '-c', {command!r}], "
            "capture_output=True, text=True, check=True, timeout=12)\n"
            f"print({_PROBE_START!r})\n"
            "print(result.stdout, end='')\n"
            f"print({_PROBE_END!r})\n"
        )
        # exec's namespace is disposable; don't overwrite the user's notebook variables.
        args = ["exec", "-s", session, "--timeout", "20"]
        binding = _kernel_bindings.get(session)
        # CLI --config pins execution to the kernel just checked. TemporaryDirectory
        # is owner-only and also removes the CLI's lock file on every exit path.
        with tempfile.TemporaryDirectory(prefix="hive-colab-") as folder:
            if binding is not None:
                config = Path(folder) / "sessions.json"
                config.touch(mode=0o600)
                config.write_text(json.dumps({session: binding}))
                args = ["--config", str(config), *args]
            output = await run_colab_command(
                args, timeout=25.0, input_text=f"exec({script!r}, {{}})\n",
            )
    # colab exec can print kernel exceptions without a nonzero CLI exit code.
    lines = output.splitlines()
    if _PROBE_START not in lines or _PROBE_END not in lines:
        raise ColabCliError("Colab exec probe did not return a complete result; the kernel or probe may have failed.")
    start, end = lines.index(_PROBE_START), lines.index(_PROBE_END)
    if end <= start:
        raise ColabCliError("Colab exec probe returned an invalid result.")
    return "\n".join(lines[start + 1:end])


_SNAPSHOT_TTL = 5.0
_snapshots: dict[str, tuple[float, dict[str, Any]]] = {}
_snapshot_tasks: dict[str, asyncio.Task] = {}


async def _collect_snapshot(session: str) -> dict[str, Any]:
    command = _REMOTE_STATS_CMD + '; echo "===PROCESSES==="; ' + _REMOTE_PROCESSES_CMD
    output = await _run_exec_probe(session, command)
    stats_output, separator, processes_output = output.partition("===PROCESSES===\n")
    if not separator:
        raise ColabCliError("Colab exec returned an incomplete status snapshot.")
    stats = _parse_stats(stats_output)
    processes = _parse_processes(processes_output)
    snapshot = {"stats": stats, "processes": processes}
    _snapshots[session] = (time.monotonic(), snapshot)
    return snapshot


async def _get_snapshot(session: str) -> dict[str, Any]:
    validate_session_name(session)
    cached = _snapshots.get(session)
    if cached and time.monotonic() - cached[0] < _SNAPSHOT_TTL:
        return cached[1]
    task = _snapshot_tasks.get(session)
    if task is None:
        task = asyncio.create_task(_collect_snapshot(session))
        _snapshot_tasks[session] = task

        def finished(completed):
            if _snapshot_tasks.get(session) is completed:
                _snapshot_tasks.pop(session)
            # Observe errors even if all waiting HTTP requests were cancelled.
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(finished)
    # One browser closing must not cancel another caller's shared probe.
    return await asyncio.shield(task)


def _parse_stats(output: str) -> dict[str, Any]:
    try:
        stats = parse_stats_output(output)
    except (ValueError, IndexError) as exc:
        raise ColabCliError("Colab exec returned invalid machine stats.") from exc
    if any(stats[key] is None for key in ("cpu_count", "cpu_percent", "load_average", "uptime", "memory", "disk")):
        raise ColabCliError("Colab exec returned incomplete machine stats.")
    return stats


def _parse_processes(output: str) -> list[dict[str, Any]]:
    lines = output.splitlines()
    if not lines or not lines[0].strip().startswith("PID "):
        raise ColabCliError("Colab exec returned an invalid process list.")
    processes = parse_processes_output(output)
    if any(line.strip() for line in lines[1:]) and not processes:
        raise ColabCliError("Colab exec returned an invalid process list.")
    return processes


async def get_colab_stats(session: str) -> dict[str, Any]:
    """Return resource stats from the session's shared exec snapshot."""
    return (await _get_snapshot(session))["stats"]


async def get_colab_processes(session: str) -> list[dict[str, Any]]:
    """Return processes from the same snapshot used for resource stats."""
    return (await _get_snapshot(session))["processes"]


async def get_colab_kernel_state(session: str, runtime_id: str) -> str:
    """Resolve a kernel, optionally start an absent one, then confirm its state."""
    validate_session_name(session)
    # Serialize even overlapping status calls before checking/creating a kernel.
    async with _get_probe_lock('kernel:' + runtime_id):
        _kernel_bindings.pop(session, None)
        try:
            records = await asyncio.to_thread(
                lambda: json.loads((Path.home() / '.config/colab-cli/sessions.json').read_text())
            )
            record = records[session]
            base = record['url'].rstrip('/')
            parsed = urlsplit(base)
            if (parsed.scheme != 'https' or not parsed.hostname or
                    not parsed.hostname.endswith('.colab.dev') or
                    parsed.username or parsed.password or parsed.port not in (None, 443) or
                    parsed.query or parsed.fragment or not runtime_id or runtime_id not in parsed.hostname):
                return 'unknown'
            kernel_id, token = record.get('kernel_id'), record['token']
            if not token:
                return 'unknown'
            headers = {'Authorization': 'Bearer ' + token,
                       'X-Colab-Runtime-Proxy-Token': token, 'X-Colab-Client-Agent': 'colab-cli'}
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                response = await client.get(
                    base + '/api/kernels' + ('/' + quote(kernel_id, safe='') if kernel_id else ''),
                    headers=headers,
                )
                if kernel_id and response.status_code == 404:
                    kernel_id = None
                    response = await client.get(base + '/api/kernels', headers=headers)
                response.raise_for_status()
                model = response.json()
                if not kernel_id:
                    if not isinstance(model, list) or len(model) > 1:
                        return 'unknown'
                    if not model:
                        if runtime_id in _kernel_start_attempts:
                            return 'unknown'
                        _kernel_start_attempts.add(runtime_id)
                        logger.info('colab.kernel.starting', extra={'runtime_id': runtime_id})
                        response = await client.post(base + '/api/kernels', headers=headers,
                                                     json={'name': 'python3'})
                        response.raise_for_status()
                        model = response.json()
                        logger.info('colab.kernel.start_requested', extra={'runtime_id': runtime_id})
                    else:
                        model = model[0]
                    if not isinstance(model, dict) or not isinstance(model.get('id'), str) or not model['id']:
                        return 'unknown'
                    kernel_id = model['id']
                    # Creation/list responses never authorize execution on their own.
                    response = await client.get(base + '/api/kernels/' + quote(kernel_id, safe=''),
                                                headers=headers)
                    response.raise_for_status()
                    model = response.json()
                if not isinstance(model, dict):
                    return 'unknown'
                state = model.get('execution_state')
                if state == 'idle':
                    _kernel_bindings[session] = {**record, 'kernel_id': kernel_id,
                                                 'session_id': None, 'last_execution': None, 'running': None}
                return state if state in ('idle', 'busy') else 'unknown'
        except (OSError, KeyError, TypeError, ValueError, httpx.HTTPError):
            logger.warning('colab.kernel_state.unavailable', extra={'runtime_id': runtime_id})
            return 'unknown'


async def collect_colab_snapshot(session: str) -> dict[str, Any]:
    """Worker-owned collection; cancellation reaches the local CLI client."""
    try:
        return await _collect_snapshot(session)
    except ColabCliError as exc:
        if 'timed out' in str(exc):
            raise TimeoutError('Colab collection timed out') from exc
        raise

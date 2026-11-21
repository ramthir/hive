"""Parsing of what the `colab` CLI and the probes inside a runtime print; pure functions, no processes."""
from __future__ import annotations

import os
import re
from typing import Any

from src.domain.colab.errors import ColabCliError

_SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_BALANCE_RE = re.compile(r"Current balance:\s*([\d.]+)\s*(.+)", re.IGNORECASE)
_RATE_RE = re.compile(r"Usage rate:\s*([\d.]+)\s*(/\S+)", re.IGNORECASE)
_ASSIGNMENTS_RE = re.compile(r"Active assignments:\s*(\d+)", re.IGNORECASE)
_SESSION_LINE_RE = re.compile(
    r"^\[([^\]]+)\]\s+(\S+)\s*\|\s*Hardware:\s*([^|]+?)\s*\|\s*Shape:\s*([^|]+?)\s*\|\s*Variant:\s*(.+?)\s*$"
)
_UPTIME_RE = re.compile(
    r"\bup\s+(.+?),\s+\d+\s+users?,\s+load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)"
)
_CPU_IDLE_RE = re.compile(r"([\d.]+)\s+id\b")


def validate_session_name(name: str) -> str:
    """Validate that a Colab session name matches safe identifier characters."""
    if not isinstance(name, str) or not _SESSION_NAME_RE.fullmatch(name):
        raise ValueError("Invalid Colab session name")
    return name


def parse_usage_output(output: str) -> dict[str, Any]:
    """Parse `colab usage` output into structured compute-unit metrics."""
    balance: float | None = None
    balance_unit = "compute units"
    usage_rate: float | None = None
    usage_rate_unit = "/hr"
    active_assignments: int | None = None

    for raw_line in output.splitlines():
        line = raw_line.strip()
        if m := _BALANCE_RE.search(line):
            balance = float(m.group(1))
            balance_unit = m.group(2).strip()
        elif m := _RATE_RE.search(line):
            usage_rate = float(m.group(1))
            usage_rate_unit = m.group(2).strip()
        elif m := _ASSIGNMENTS_RE.search(line):
            active_assignments = int(m.group(1))

    if balance is None and usage_rate is None and active_assignments is None:
        raise ColabCliError("Could not parse `colab usage` output")

    return {
        "balance": balance,
        "balance_unit": balance_unit,
        "usage_rate": usage_rate,
        "usage_rate_unit": usage_rate_unit,
        "active_assignments": active_assignments,
    }


def parse_sessions_output(output: str) -> list[dict[str, str]]:
    """Parse `colab sessions` output into a list of active session dicts."""
    sessions: list[dict[str, str]] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or "No active sessions found" in line:
            continue
        if m := _SESSION_LINE_RE.match(line):
            sessions.append(
                {
                    "name": m.group(1).strip(),
                    "runtime_id": m.group(2).strip(),
                    "hardware": m.group(3).strip(),
                    "shape": m.group(4).strip(),
                    "variant": m.group(5).strip(),
                }
            )
    return sessions


def _split_sections(output: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("===") and stripped.endswith("===") and len(stripped) > 6:
            current = stripped[3:-3]
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append(line)
    return {key: "\n".join(lines).strip() for key, lines in sections.items()}


def parse_stats_output(output: str) -> dict[str, Any]:
    """Parse sectioned machine probe output into stat card fields."""
    sections = _split_sections(output)

    cpu_count: int | None = None
    if cores_text := sections.get("CORES", "").strip():
        try:
            cpu_count = int(cores_text.splitlines()[0].strip())
        except ValueError:
            cpu_count = None

    uptime_str: str | None = None
    load_average: dict[str, float] | None = None
    if uptime_text := sections.get("UPTIME", "").strip():
        if m := _UPTIME_RE.search(uptime_text):
            uptime_str = re.sub(r"\s+", " ", m.group(1).strip())
            load_average = {
                "1min": float(m.group(2)),
                "5min": float(m.group(3)),
                "15min": float(m.group(4)),
            }

    cpu_percent: float | None = None
    if cpu_text := sections.get("CPU", "").strip():
        if m := _CPU_IDLE_RE.search(cpu_text):
            idle = float(m.group(1))
            cpu_percent = round(max(0.0, min(100.0, 100.0 - idle)), 1)

    memory: dict[str, float] | None = None
    for line in sections.get("MEM", "").splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            if len(parts) >= 3:
                total_mb = float(parts[1])
                used_mb = float(parts[2])
                pct = round((used_mb / total_mb) * 100, 1) if total_mb > 0 else 0.0
                memory = {
                    "used_gb": round(used_mb / 1024, 1),
                    "total_gb": round(total_mb / 1024, 1),
                    "percent": pct,
                }
            break

    disk: dict[str, float] | None = None
    disk_lines = [ln for ln in sections.get("DISK", "").splitlines() if ln.strip()]
    if len(disk_lines) >= 2:
        parts = disk_lines[1].split()
        if len(parts) >= 5:
            total_mb = float(parts[1].rstrip("M"))
            used_mb = float(parts[2].rstrip("M"))
            pct = float(parts[4].rstrip("%"))
            disk = {
                "used_gb": round(used_mb / 1024, 1),
                "total_gb": round(total_mb / 1024, 1),
                "percent": pct,
            }

    gpus: list[dict[str, Any]] = []
    for line in sections.get("GPU", "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = [p.strip() for p in stripped.split(",")]
        if len(parts) >= 4:
            try:
                util = float(parts[1])
                mem_used = float(parts[2])
                mem_total = float(parts[3])
            except ValueError:
                continue
            mem_pct = round((mem_used / mem_total) * 100, 1) if mem_total > 0 else 0.0
            gpus.append(
                {
                    "name": parts[0],
                    "utilization_percent": util,
                    "memory_used_mb": mem_used,
                    "memory_total_mb": mem_total,
                    "memory_percent": mem_pct,
                }
            )

    return {
        "cpu_count": cpu_count,
        "cpu_percent": cpu_percent,
        "load_average": load_average,
        "uptime": uptime_str,
        "memory": memory,
        "disk": disk,
        "gpu": gpus,
    }


def _format_rss_kb(rss_kb: float) -> str:
    if rss_kb >= 1024 * 1024:
        return f"{rss_kb / (1024 * 1024):.1f} GB"
    if rss_kb >= 1024:
        return f"{rss_kb / 1024:.1f} MB"
    return f"{int(rss_kb)} KB"


def _format_colab_cmdline(name: str, raw_args: str) -> str:
    """Format `ps` args into a concise `cmdline` matching Pandora's Top Processes."""
    text = raw_args.strip()
    if not text or text == name or text.startswith("["):
        return ""
    tokens = text.split()
    first_base = os.path.basename(tokens[0]).lstrip("-")
    if first_base and (first_base.casefold() == name.casefold() or name.casefold().startswith(first_base.casefold()) or first_base.casefold().startswith(name.casefold())):
        tokens = tokens[1:]
    if not tokens:
        return ""
    if tokens[0].startswith(("/", "./")):
        tokens[0] = os.path.basename(tokens[0]) or tokens[0]
    cmdline = " ".join(tokens)
    if len(cmdline) > 200:
        cmdline = cmdline[:199] + "…"
    return cmdline


def parse_processes_output(output: str, limit: int = 100) -> list[dict[str, Any]]:
    """Parse `ps -eo pid,pcpu,pmem,rss,etime,comm,args` output for `<process-list>`."""
    processes: list[dict[str, Any]] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("PID"):
            continue
        parts = line.split(None, 6)
        if len(parts) < 6:
            continue
        try:
            pid = int(parts[0])
            cpu_percent = float(parts[1])
            mem_percent = float(parts[2])
            rss_kb = float(parts[3])
        except ValueError:
            continue
        running_for = parts[4]
        name = parts[5]
        raw_args = parts[6] if len(parts) > 6 else name
        cmdline = _format_colab_cmdline(name, raw_args)
        processes.append(
            {
                "pid": pid,
                "name": name,
                "cmdline": cmdline,
                "command": raw_args[:200],
                "running_for": running_for,
                "cpu_percent": round(cpu_percent, 1),
                "mem_percent": round(mem_percent, 1),
                "mem": _format_rss_kb(rss_kb),
                "status": "running",
            }
        )
        if len(processes) >= limit:
            break
    return processes

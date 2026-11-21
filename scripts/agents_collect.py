#!/usr/bin/env python3
"""Make the Agents tab's reports now: uv run python scripts/agents_collect.py [usage|quota|all] [--output FILE] [--ccusage PATH]

Hive refreshes both reports by itself every 15 minutes while the tab is open, so this is only for forcing a run by hand
or checking that ccusage and the agents' CLIs work. `usage` runs ccusage (tokens and sessions), `quota` asks Claude, Codex
and Antigravity for their 5-hour and weekly limits. Files are replaced atomically; a failed run leaves the last good one.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.application.agents.quota import AgentQuota  # noqa: E402
from src.application.agents.usage import AgentUsage  # noqa: E402
from src.domain.agents.quota import QuotaError, parse_snapshot  # noqa: E402
from src.infrastructure.agents.quota_sources import QuotaCollector  # noqa: E402
from src.infrastructure.agents.usage_files import CcusageCollector, ReportStore  # noqa: E402


def state_dir() -> Path:
    return Path(os.environ.get("HIVE_STATE_DIR") or "~/.local/state/hive").expanduser() / "agents"


def collect_usage(output: Path, collector) -> tuple[bool, str]:
    usage = AgentUsage(ReportStore(output), collector)
    if not usage.refresh():
        return False, str(usage.error)
    view = usage.view()
    used = [f"{name} {p['tokens']['total']:,} tokens" for name, p in view["providers"].items() if p.get("tokens")]
    return True, f"{output}: {view['month']}, {', '.join(used) or 'no usage'}"


def collect_quota(output: Path, collector) -> tuple[bool, str]:
    quota = AgentQuota(ReportStore(output, parse_snapshot, (QuotaError,), "quota snapshot"), collector)
    if not quota.refresh():
        return False, str(quota.error)
    parts = []
    for name, provider in quota.view()["providers"].items():
        windows = provider["windows"]
        read = ", ".join(f"{key} {w['used_pct']:g}% used" for key, w in windows.items() if w["used_pct"] is not None)
        parts.append(f"{name}: {read or provider['reason'] or 'no reading'}")
    return True, f"{output}: " + "; ".join(parts)


def main(argv=None, usage_collector=None, quota_collector=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("what", nargs="?", choices=["usage", "quota", "all"], default="all")
    parser.add_argument("--output", type=Path, help="the file to write (with `all`, the folder for usage.json and quota.json)")
    parser.add_argument("--ccusage", default=os.environ.get("HIVE_CCUSAGE") or None)
    args = parser.parse_args(argv)
    folder = args.output if args.what == "all" and args.output else state_dir()
    jobs = []
    if args.what in ("usage", "all"):
        jobs.append(("usage", collect_usage, args.output if args.what == "usage" and args.output else folder / "usage.json", usage_collector or CcusageCollector(args.ccusage)))
    if args.what in ("quota", "all"):
        jobs.append(("quota", collect_quota, args.output if args.what == "quota" and args.output else folder / "quota.json", quota_collector or QuotaCollector()))
    failed = False
    for name, job, output, collector in jobs:
        ok, message = job(output, collector)
        print(message if ok else f"agents-collect {name}: {message}", file=sys.stdout if ok else sys.stderr)
        failed = failed or not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

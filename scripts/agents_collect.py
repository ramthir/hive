#!/usr/bin/env python3
"""Make the Agents page's usage report now: uv run python scripts/agents_collect.py [--output FILE] [--ccusage PATH]

Hive refreshes the report by itself every 15 minutes while the page is open, so this is only for forcing a run by hand
or checking that ccusage works. The file is replaced atomically; a failed run leaves the last good one in place.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.application.agents.usage import AgentUsage  # noqa: E402
from src.infrastructure.agents.usage_files import CcusageCollector, ReportStore  # noqa: E402


def default_output() -> Path:
    return Path(os.environ.get("HIVE_STATE_DIR") or "~/.local/state/hive").expanduser() / "agents" / "usage.json"


def main(argv=None, collector=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", type=Path, default=default_output())
    parser.add_argument("--ccusage", default=os.environ.get("HIVE_CCUSAGE") or None)
    args = parser.parse_args(argv)
    usage = AgentUsage(ReportStore(args.output), collector or CcusageCollector(args.ccusage))
    if not usage.refresh():
        print(f"agents-collect: {usage.error}", file=sys.stderr)
        return 1
    view = usage.view()
    used = [f"{name} {p['tokens']['total']:,} tokens" for name, p in view["providers"].items() if p.get("tokens")]
    print(f"{args.output}: {view['month']}, {', '.join(used) or 'no usage'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

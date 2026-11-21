import json
import subprocess
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from src.domain.agents.usage import CollectError, parse_envelope
from src.infrastructure.agents.usage_files import CcusageCollector, ReportStore, find_ccusage
from tests.agent_reports import envelope, report

NOW = datetime(2026, 11, 21, 8, 0, tzinfo=timezone.utc)


def runner(stdout=None, code=0, stderr="", seen=None):
    def run(command, **kwargs):
        if seen is not None:
            seen.append((command, kwargs))
        return SimpleNamespace(returncode=code, stdout=json.dumps(report()) if stdout is None else stdout, stderr=stderr)
    return run


def test_collect_asks_ccusage_for_this_month_in_the_host_timezone():
    seen = []
    raw = CcusageCollector("/opt/bin/ccusage", run=runner(seen=seen), tz_name="Asia/Colombo").collect(NOW)
    command, kwargs = seen[0]
    assert command[0] == "/opt/bin/ccusage" and command[command.index("--since") + 1] == "20261101"
    assert command[command.index("-z") + 1] == "Asia/Colombo" and "--by-agent" in command and "--offline" in command
    assert kwargs["env"]["PATH"].startswith("/opt/bin:")  # so its `#!/usr/bin/env node` finds node
    assert raw["since"] == "2026-11-01" and raw["timezone"] == "Asia/Colombo"
    parse_envelope(raw)  # the application accepts what the collector makes


def test_the_month_starts_in_the_host_timezone_not_utc():
    seen = []
    CcusageCollector("/x/ccusage", run=runner(seen=seen), tz_name="Asia/Colombo").collect(datetime(2026, 10, 31, 20, 0, tzinfo=timezone.utc))
    assert seen[0][0][seen[0][0].index("--since") + 1] == "20261101"  # already 1 Nov in Colombo (UTC+5:30)


@pytest.mark.parametrize("run, message", [
    (runner(code=2, stderr="boom"), "exited 2: boom"),
    (runner(stdout="not json"), "did not print JSON"),
    (lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired("ccusage", 5)), "did not finish"),
    (lambda *a, **k: (_ for _ in ()).throw(PermissionError(13, "Permission denied")), "could not be started"),
])
def test_collect_failures_say_what_went_wrong(run, message):
    with pytest.raises(CollectError, match=message):
        CcusageCollector("/x/ccusage", run=run, tz_name="UTC").collect(NOW)


def test_a_missing_ccusage_says_how_to_fix_it(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(CollectError, match="HIVE_CCUSAGE"):
        CcusageCollector(run=runner(), tz_name="UTC").collect(NOW)


def test_find_ccusage_falls_back_to_a_version_managers_node(monkeypatch, tmp_path):
    bin_dir = tmp_path / ".local/share/mise/installs/node/26/bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "ccusage").write_text("#!/bin/sh\n")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("HOME", str(tmp_path))
    assert find_ccusage() == str(bin_dir / "ccusage")
    assert find_ccusage("/given/ccusage") == "/given/ccusage"


def test_the_store_parses_again_only_when_the_file_changes(tmp_path):
    store = ReportStore(tmp_path / "agents" / "usage.json")
    assert store.load() == (None, "No usage report has been generated yet.")
    store.save(envelope(NOW))
    first, _ = store.load()
    assert first["since"].isoformat() == "2026-11-01"
    store.load(); store.load()
    assert store.parses == 1
    store.save(envelope(NOW, since="2026-10-01"))
    assert store.load()[0]["since"].isoformat() == "2026-10-01" and store.parses == 2


def test_a_damaged_file_is_reported_not_raised(tmp_path):
    path = tmp_path / "usage.json"
    path.write_text("{oops")
    assert "cannot be read" in ReportStore(path).load()[1]
    path.write_text(json.dumps({"schema_version": 9}))
    assert "invalid" in ReportStore(path).load()[1]


def test_a_failed_write_keeps_the_last_good_report_and_leaves_no_temp_file(tmp_path):
    store = ReportStore(tmp_path / "usage.json")
    store.save(envelope(NOW))
    with pytest.raises(TypeError):
        store.save({"bad": object()})
    assert store.load()[0] is not None
    assert [p.name for p in tmp_path.iterdir()] == ["usage.json"]

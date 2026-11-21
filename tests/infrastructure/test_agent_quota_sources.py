import json
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.domain.agents.quota import parse_snapshot
from src.infrastructure.agents import quota_sources as q
from src.infrastructure.agents.quota_sources import CliError, QuotaCollector, parse_agy_usage, parse_claude_usage, parse_codex_rpc

NOW = datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc)
CLAUDE = """You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Nov 21, 10:29am (UTC)
Current week (all models): 28% used · resets Nov 26, 3:59pm (UTC)

What's contributing to your usage?
"""
AGY = ("Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-28T09:53:30Z\nGemini Models\tFive Hour Limit Remaining\t90%\t2026-11-21T14:53:30Z\n"
       "Claude and GPT models\tWeekly Limit Remaining\t10%\t2026-11-28T09:53:30Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t55%\t2026-11-28T09:53:30Z\n")
RPC = {"rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 34, "windowDurationMins": 300, "resetsAt": 1795267390},
                                         "secondary": {"usedPercent": 21, "windowDurationMins": 10080, "resetsAt": 1795833720}}}}


def test_claude_lines_become_5h_and_weekly_windows_with_the_reset_in_utc():
    windows = parse_claude_usage(CLAUDE, NOW)
    assert windows["5h"] == {"used_pct": 39.0, "resets_at": "2026-11-21T10:29:00+00:00", "collected_at": NOW.isoformat()}
    assert windows["7d"]["used_pct"] == 28.0 and windows["7d"]["resets_at"] == "2026-11-26T15:59:00+00:00"


def test_claude_resets_are_converted_from_the_zone_they_name_and_may_drop_the_minutes():
    text = "Current session: 5% used · resets Nov 4, 11am (Asia/Colombo)\nCurrent week (all models): 1% used · resets Nov 5, 9:30pm (America/New_York)\n"
    windows = parse_claude_usage(text, datetime(2026, 11, 3, tzinfo=timezone.utc))
    assert windows["5h"]["resets_at"] == "2026-11-04T05:30:00+00:00"
    assert windows["7d"]["resets_at"] == "2026-11-06T02:30:00+00:00"


def test_a_session_line_without_a_reset_is_a_reading_with_no_reset_time():
    assert parse_claude_usage("Current session: 0% used\n", NOW)["5h"] == {"used_pct": 0.0, "resets_at": None, "collected_at": NOW.isoformat()}


def test_a_malformed_or_missing_claude_line_is_left_out_not_invented():
    assert parse_claude_usage("Current session: 5% used · resets someday (UTC)\nnothing else\n", NOW) == {}


def test_a_december_reset_read_in_january_belongs_to_the_next_year():
    windows = parse_claude_usage("Current session: 5% used · resets Jan 2, 1am (UTC)\n", datetime(2026, 12, 31, 20, tzinfo=timezone.utc))
    assert windows["5h"]["resets_at"].startswith("2027-01-02")


def test_antigravity_remaining_allowance_becomes_used_percent_for_gemini_and_argon_only():
    windows = parse_agy_usage(AGY, NOW)
    assert list(windows) == ["7d", "5h", "argon-7d"]  # the Claude and GPT pool is not shown
    assert windows["5h"]["used_pct"] == 10.0 and windows["5h"]["pool"] == "Gemini Models"
    assert windows["argon-7d"]["used_pct"] == 45.0 and windows["argon-7d"]["resets_at"] == "2026-11-28T09:53:30+00:00"


def test_codex_app_server_windows_are_matched_by_their_length():
    windows = parse_codex_rpc(RPC, NOW)
    assert windows["5h"]["used_pct"] == 34.0 and windows["5h"]["resets_at"] == "2026-11-21T13:23:10+00:00"
    assert windows["7d"]["used_pct"] == 21.0


def test_codex_logs_give_the_newest_rate_limit_event(tmp_path):
    day = tmp_path / "2026" / "11" / "21"
    day.mkdir(parents=True)
    old = {"timestamp": "2026-11-21T01:00:00Z", "payload": {"rate_limits": {"primary": {"used_percent": 1, "window_minutes": 300, "resets_at": 1795267390}}}}
    new = {"timestamp": "2026-11-21T02:00:00Z", "payload": {"rate_limits": {"primary": {"used_percent": 9.5, "window_minutes": 300, "resets_at": 1795267390},
                                                                              "secondary": {"used_percent": 3, "window_minutes": 10080, "resets_at": 1795833720}}}}
    (day / "rollout-a.jsonl").write_text("\n".join(["not json", json.dumps({"x": 1}), json.dumps(old), json.dumps(new)]))
    windows, reason = q.codex_log_windows(tmp_path, NOW)
    assert reason is None and windows["5h"]["used_pct"] == 9.5 and windows["5h"]["collected_at"] == "2026-11-21T02:00:00Z" and windows["7d"]["used_pct"] == 3.0


def test_codex_logs_say_why_there_is_nothing(tmp_path):
    assert q.codex_log_windows(tmp_path / "missing", NOW) == ({}, "No Codex session logs found.")
    (tmp_path / "a.jsonl").write_text("{}\n")
    assert q.codex_log_windows(tmp_path, NOW)[1] == "No Codex rate-limit event found in recent session logs."


def collector(tmp_path, claude=lambda: CLAUDE, agy=lambda: AGY, rpc=lambda method: RPC):
    return QuotaCollector(claude, agy, rpc, tmp_path / "no-codex-logs")


def test_the_snapshot_has_every_provider_and_is_accepted_by_the_domain(tmp_path):
    raw = collector(tmp_path).collect(NOW)
    parse_snapshot(raw)
    assert list(raw["providers"]) == ["claude", "codex", "antigravity"] and all(p["status"] == "ok" for p in raw["providers"].values())
    assert raw["providers"]["codex"]["windows"]["5h"]["status"] == "ok"


def test_one_failing_cli_is_unavailable_with_its_reason_and_does_not_hide_the_others(tmp_path):
    def broken():
        raise CliError("claude did not finish /usage.")
    raw = collector(tmp_path, claude=broken).collect(NOW)
    assert raw["providers"]["claude"] == {"status": "unavailable", "reason": "claude did not finish /usage.", "windows": {}}
    assert raw["providers"]["codex"]["status"] == "ok" and raw["providers"]["antigravity"]["status"] == "ok"


def test_text_with_no_windows_is_named_as_such(tmp_path):
    raw = collector(tmp_path, agy=lambda: "nothing useful").collect(NOW)
    assert raw["providers"]["antigravity"]["reason"] == "Antigravity /usage printed no quota windows."


def test_a_window_whose_reset_has_passed_is_published_expired_with_no_value(tmp_path):
    raw = collector(tmp_path, claude=lambda: "Current session: 80% used · resets Nov 21, 8:00am (UTC)\n").collect(NOW)
    assert raw["providers"]["claude"]["windows"]["5h"] == {"status": "expired", "used_pct": None, "resets_at": "2026-11-21T08:00:00+00:00", "collected_at": NOW.isoformat()}


def test_codex_falls_back_to_its_session_logs_when_the_app_server_fails(tmp_path):
    (tmp_path / "logs").mkdir()
    event = {"timestamp": NOW.isoformat(), "payload": {"rate_limits": {"primary": {"used_percent": 12, "window_minutes": 300, "resets_at": int(NOW.timestamp()) + 3600}}}}
    (tmp_path / "logs" / "r.jsonl").write_text(json.dumps(event))

    def down(method):
        raise RuntimeError("Codex app server closed before replying")
    raw = QuotaCollector(lambda: CLAUDE, lambda: AGY, down, tmp_path / "logs").collect(NOW)
    assert raw["providers"]["codex"]["windows"]["5h"]["used_pct"] == 12.0
    raw = QuotaCollector(lambda: CLAUDE, lambda: AGY, down, tmp_path / "nothing").collect(NOW)
    assert raw["providers"]["codex"] == {"status": "unavailable", "reason": "No Codex session logs found.", "windows": {}}


def test_the_three_agents_are_read_at_the_same_time(tmp_path):
    started, release = [], threading.Event()

    def slow(text):
        def run():
            started.append(text)
            release.wait(5)
            return text
        return run

    def rpc(method):
        started.append("codex")
        release.wait(5)
        return RPC
    c = QuotaCollector(slow(CLAUDE), slow(AGY), rpc, tmp_path)
    worker = threading.Thread(target=lambda: c.collect(NOW))
    worker.start()
    deadline = time.time() + 3
    while len(started) < 3 and time.time() < deadline:
        time.sleep(0.01)
    release.set()
    worker.join(5)
    assert len(started) == 3  # all three were running before any finished


def fake_run(stdout="", code=0, raises=None):
    def run(command, **kwargs):
        run.command, run.kwargs = command, kwargs
        if raises:
            raise raises
        return SimpleNamespace(returncode=code, stdout=stdout)
    return run


def test_a_cli_is_called_with_json_output_from_the_home_folder_and_its_text_returned(monkeypatch):
    run = fake_run(json.dumps({"is_error": False, "result": "hello"}))
    monkeypatch.setattr(q.subprocess, "run", run)
    assert q.run_cli_json("/x/claude", "claude", ["-p", "/usage"], "result", lambda r: r.get("is_error")) == "hello"
    assert run.command == ["/x/claude", "-p", "/usage", "--output-format", "json"] and run.kwargs["cwd"] == str(Path.home())


@pytest.mark.parametrize("run, message", [
    (fake_run(raises=subprocess.TimeoutExpired("x", 1)), "did not finish /usage"),
    (fake_run(raises=FileNotFoundError()), "did not finish /usage"),
    (fake_run(stdout="plain text"), "printed no JSON"),
    (fake_run(stdout="[1]"), "unexpected reply"),
    (fake_run(stdout=json.dumps({"is_error": True, "result": "Not logged in"})), "reported an error for /usage: Not logged in"),
])
def test_a_cli_failure_says_what_went_wrong(monkeypatch, run, message):
    monkeypatch.setattr(q.subprocess, "run", run)
    with pytest.raises(CliError, match=message):
        q.run_cli_json("/x/claude", "claude", [], "result", lambda r: r.get("is_error"))


def test_claude_is_asked_not_to_save_a_session_so_it_never_shows_on_the_sessions_table(monkeypatch):
    run = fake_run(json.dumps({"is_error": False, "result": CLAUDE}))
    monkeypatch.setattr(q.subprocess, "run", run)
    q.run_claude_usage()
    assert "--no-session-persistence" in run.command and run.command[1:3] == ["-p", "/usage"]


def test_programs_are_found_by_env_then_path_then_local_bin(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.delenv("AGY_BIN", raising=False)
    assert q.find_program("agy", "AGY_BIN") == "agy"
    (tmp_path / ".local/bin").mkdir(parents=True)
    (tmp_path / ".local/bin/agy").write_text("#!/bin/sh\n")
    assert q.find_program("agy", "AGY_BIN") == str(tmp_path / ".local/bin/agy")
    monkeypatch.setenv("AGY_BIN", "/custom/agy")
    assert q.find_program("agy", "AGY_BIN") == "/custom/agy"

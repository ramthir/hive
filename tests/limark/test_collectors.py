import json
import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.infrastructure.limark.aws_report import AWSReport
from src.infrastructure.limark.openai_report import OpenAIReport

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
NOW = datetime(2026, 10, 3, tzinfo=timezone.utc)


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz)


def test_openai_collector_publishes_and_reuses_snapshot(tmp_path, monkeypatch):
    main = runpy.run_path(str(SCRIPTS / "openai-usage-sync"))["main"]
    module = main.__globals__
    calls = []

    def pages(self, endpoint, params, projects=False):
        calls.append(endpoint)
        if projects:
            return [{"id": "p1", "name": "Example"}]
        if endpoint == "costs":
            return [{"start_time": int(NOW.timestamp()), "results": [
                {"project_id": "p1", "line_item": "gpt-test, input", "amount": {"value": "1.25", "currency": "usd"}}
            ]}]
        return []

    monkeypatch.setattr(module["Client"], "pages", pages)
    monkeypatch.setitem(module, "datetime", Clock)
    monkeypatch.setenv("HIVE_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("OPENAI_ADMIN_KEY", "fixture")
    monkeypatch.delenv("LIMARK_OPENAI_REPORT", raising=False)
    monkeypatch.setattr(sys, "argv", ["openai-usage-sync", "--config", str(tmp_path / "absent")])
    main()
    main()
    assert calls == ["costs", "usage/completions", "projects"]
    output = tmp_path / "limark" / "openai.json"
    assert OpenAIReport(output).view("2026-10", now=NOW)["totals"] == [{"amount": "1.25", "currency": "usd"}]
    assert output.stat().st_mode & 0o777 == 0o600


def test_aws_collector_keeps_previous_report_on_failed_refresh(tmp_path, monkeypatch):
    main = runpy.run_path(str(SCRIPTS / "aws-usage-sync"))["main"]
    module = main.__globals__

    def collect(profile, account, first, last, dashboard):
        from datetime import date, timedelta

        assert (profile, account, dashboard) == ("test", "123456789012", True)
        start, end = date.fromisoformat(first), date.fromisoformat(last)
        days = [(start + timedelta(days=n)).isoformat() for n in range((end - start).days)]
        return ([{"date": days[-1], "service": "Amazon S3", "amount": "2", "currency": "USD"}],
                [{"date": day, "estimated": False} for day in days])

    monkeypatch.setitem(module, "datetime", Clock)
    monkeypatch.setitem(module, "verify_account", lambda profile, account: None)
    monkeypatch.setitem(module, "collect", collect)
    monkeypatch.setenv("HIVE_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("LIMARK_AWS_DASHBOARD_REPORT", raising=False)
    monkeypatch.setattr(sys, "argv", ["aws-usage-sync", "--profile", "test", "--account", "123456789012", "--refresh"])
    main()
    output = tmp_path / "limark" / "aws-dashboard.json"
    assert AWSReport(output).view("2026-10", now=NOW, dashboard=True)["totals"] == [{"amount": "2", "currency": "USD"}]
    before = output.read_bytes()
    assert output.stat().st_mode & 0o777 == 0o600

    def fail(*args, **kwargs):
        raise ValueError("fixture failure")

    monkeypatch.setitem(module, "collect", fail)
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 1
    assert output.read_bytes() == before
    assert json.loads(output.with_suffix(".json.status.json").read_text())["ok"] is False

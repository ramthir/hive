from datetime import datetime, timedelta, timezone

import pytest

from src.domain.agents.usage import ReportError, build_view, empty_session_page, parse_envelope, session_page
from tests.agent_reports import agent_row, envelope, report, session

NOW = datetime(2026, 11, 21, 8, 0, tzinfo=timezone.utc)


def view(**kw):
    return build_view(parse_envelope(envelope(kw.pop("generated", NOW), **kw)), NOW)


def test_tokens_count_cache_reads_and_writes_as_input():
    body = report(days=[{"period": "2026-11-20", "agents": [agent_row("claude", inp=100, cache_read=900, cache_write=40, out=50)]}])
    claude = view(body=body)["providers"]["claude"]
    assert claude["tokens"] == {"input": 1040, "cached_input": 900, "cache_write": 40, "output": 50, "total": 1090}
    assert claude["status"] == "available" and claude["models"] == ["claude-sonnet-5-5"]
    assert claude["daily"] == [{"date": "2026-11-20", "input": 1040, "cached_input": 900, "cache_write": 40, "output": 50, "total": 1090}]


def test_each_provider_has_its_own_card_and_one_without_usage_says_so():
    providers = view()["providers"]
    assert list(providers) == ["claude", "codex", "antigravity"]
    assert providers["codex"]["models"] == ["gpt-5"] and providers["codex"]["sessions"] == 1
    assert providers["antigravity"]["status"] == "no_usage" and providers["antigravity"]["sessions"] == 0


def test_a_fresh_report_is_ok_and_an_old_one_is_stale_but_keeps_its_numbers():
    assert view()["status"] == "ok"
    old = view(generated=NOW - timedelta(minutes=46))
    assert old["status"] == "stale" and old["providers"]["claude"]["tokens"]["total"] > 0


def test_a_report_for_another_month_waits_instead_of_showing_old_numbers():
    last_month = view(since="2026-10-01")
    assert last_month["status"] == "waiting" and last_month["month"] == "2026-11"
    assert all(p["status"] == "waiting" for p in last_month["providers"].values())


def test_rows_without_usable_counts_are_skipped_and_counted():
    bad = {"agent": "claude", "inputTokens": "many"}
    body = report(sessions=[bad, session("claude", "ok", "2026-11-20T10:00:00Z")])
    result = view(body=body)
    assert result["skipped_rows"] == 1 and result["providers"]["claude"]["sessions"] == 1


def test_sessions_are_sorted_across_the_month_and_paged():
    env = parse_envelope(envelope(NOW))
    newest = session_page(env, NOW, page_size=2)
    assert [s["session"] for s in newest["items"]] == ["sess-b", "sess-a"] and newest["total"] == 3
    by_total = session_page(env, NOW, sort="total", direction="asc", page_size=2)
    assert [s["session"] for s in by_total["items"]] == ["sess-c", "sess-b"]
    assert [s["session"] for s in session_page(env, NOW, page=1, page_size=2)["items"]] == ["sess-c"]
    only_claude = session_page(env, NOW, provider="claude")
    assert only_claude["total"] == 2 and all(s["provider"] == "claude" for s in only_claude["items"])


def test_sessions_sort_mixed_timezone_timestamps_chronologically_and_missing_last():
    body = report(sessions=[
        session("claude", "utc-later", "2026-11-20T10:00:00Z"),
        session("codex", "ist-earlier", "2026-11-20T14:00:00+05:30"),  # 08:30Z, earlier despite larger local hour
        session("claude", "missing", None),
    ])
    env = parse_envelope(envelope(NOW, body=body))
    desc = [s["session"] for s in session_page(env, NOW, sort="last_activity", direction="desc")["items"]]
    asc = [s["session"] for s in session_page(env, NOW, sort="last_activity", direction="asc")["items"]]
    assert desc == ["utc-later", "ist-earlier", "missing"]
    assert asc == ["ist-earlier", "utc-later", "missing"]


@pytest.mark.parametrize("args", [{"sort": "name"}, {"direction": "up"}, {"page": -1}, {"page_size": 0}, {"page_size": 51}, {"provider": "other"}])
def test_bad_paging_is_rejected(args):
    with pytest.raises(ValueError):
        empty_session_page(**args)


@pytest.mark.parametrize("raw", [None, {}, {"schema_version": 2}, {"schema_version": 1, "report": {"daily": [], "session": []}, "since": "x"}])
def test_an_unusable_file_is_a_report_error(raw):
    with pytest.raises(ReportError):
        parse_envelope(raw)


def test_a_timestamp_needs_a_timezone():
    with pytest.raises(ReportError):
        parse_envelope({**envelope(NOW), "generated_at": "2026-11-21T08:00:00"})

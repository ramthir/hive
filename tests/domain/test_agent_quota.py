from datetime import datetime, timedelta, timezone

import pytest

from src.domain.agents.quota import QuotaError, build_view, parse_snapshot, unavailable_view
from tests.agent_reports import quota_snapshot, quota_window

NOW = datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc)


def view(raw, now=NOW):
    return build_view(parse_snapshot(raw), now)


def test_each_provider_has_its_5h_and_weekly_windows_even_with_a_legacy_argon_window():
    raw = quota_snapshot(NOW)
    raw["providers"]["antigravity"]["windows"]["argon-7d"] = quota_window(45.0, NOW + timedelta(days=4), NOW)
    providers = view(raw)["providers"]
    assert all(list(provider["windows"]) == ["5h", "7d"] for provider in providers.values())
    assert providers["claude"]["windows"]["5h"] == {"state": "ok", "used_pct": 40.0, "resets_at": (NOW + timedelta(hours=2)).isoformat()}


def test_a_provider_without_a_reading_is_unavailable_with_its_reason_and_no_values():
    claude = view(quota_snapshot(NOW, ok=("codex",)))["providers"]["claude"]
    assert claude["status"] == "unavailable" and "no quota windows" in claude["reason"]
    assert claude["windows"]["7d"] == {"state": "unavailable", "used_pct": None, "resets_at": None}


def test_an_old_snapshot_is_stale_and_shows_no_value_but_keeps_the_reset_time():
    body = view(quota_snapshot(NOW - timedelta(minutes=46)))
    window = body["providers"]["codex"]["windows"]["5h"]
    assert body["stale"] is True and window["state"] == "stale" and window["used_pct"] is None and window["resets_at"]
    assert view(quota_snapshot(NOW - timedelta(minutes=45)))["stale"] is False


def test_a_reading_older_than_the_snapshot_is_stale_by_itself():
    raw = quota_snapshot(NOW)
    raw["providers"]["codex"]["windows"]["5h"]["collected_at"] = (NOW - timedelta(hours=2)).isoformat()
    windows = view(raw)["providers"]["codex"]["windows"]
    assert windows["5h"]["state"] == "stale" and windows["7d"]["state"] == "ok"


def test_a_window_whose_reset_has_passed_is_expired_not_current():
    raw = quota_snapshot(NOW)
    raw["providers"]["claude"]["windows"]["5h"] = quota_window(80.0, NOW - timedelta(minutes=1), NOW)
    assert view(raw)["providers"]["claude"]["windows"]["5h"]["state"] == "expired"


def test_a_reading_with_no_reset_time_is_still_a_measurement():
    raw = quota_snapshot(NOW)
    raw["providers"]["claude"]["windows"]["5h"] = quota_window(0.0, None, NOW)
    window = view(raw)["providers"]["claude"]["windows"]["5h"]
    assert window == {"state": "ok", "used_pct": 0.0, "resets_at": None}


def test_unavailable_view_names_the_reason_for_every_provider():
    body = unavailable_view("The quota is being collected.")
    assert body["generated_at"] is None and all(p["reason"] == "The quota is being collected." for p in body["providers"].values())


@pytest.mark.parametrize("raw", [None, {"schema_version": 2}, {"schema_version": 1, "generated_at": "2026-11-21T09:00:00+00:00"}, {"schema_version": 1, "providers": {}, "generated_at": "2026-11-21T09:00:00"}])
def test_an_unusable_snapshot_is_refused(raw):
    with pytest.raises(QuotaError):
        parse_snapshot(raw)

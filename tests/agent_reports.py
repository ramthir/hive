"""ccusage-shaped reports for the Agents tests."""
from __future__ import annotations

from datetime import datetime


def agent_row(agent, inp=100, cache_read=900, cache_write=0, out=50, model="claude-sonnet-5-5"):
    raw = {"inputTokens": inp, "cacheReadTokens": cache_read, "cacheCreationTokens": cache_write, "outputTokens": out}
    return {"agent": agent, **raw, "modelsUsed": [model], "modelBreakdowns": [{"modelName": model, **raw}]}


def session(agent, period, last, **tokens):
    return {**agent_row(agent, **tokens), "period": period, "metadata": {"lastActivity": last}}


def report(days=None, sessions=None):
    return {"daily": days if days is not None else [{"period": "2026-11-20", "agents": [agent_row("claude"), agent_row("codex", model="gpt-5", inp=10, cache_read=0, out=5)]}],
            "session": sessions if sessions is not None else [
                session("claude", "sess-a", "2026-11-20T10:00:00Z"),
                session("codex", "sess-b", "2026-11-20T11:00:00Z", inp=10, cache_read=0, out=5, model="gpt-5"),
                session("claude", "sess-c", "2026-11-19T09:00:00Z", inp=1, cache_read=2, out=3)]}


def envelope(now: datetime, since="2026-11-01", tz="UTC", body=None):
    return {"schema_version": 1, "generated_at": now.isoformat(), "since": since, "timezone": tz, "report": body or report()}


def quota_window(used, resets, collected, status="ok", **extra):
    return {"status": status, "used_pct": used, "resets_at": resets.isoformat() if resets else None, "collected_at": collected.isoformat(), **extra}


def quota_snapshot(now, ok=("claude", "codex", "antigravity"), five=40.0, week=29.0):
    """A quota snapshot as the collector writes it, with the providers in `ok` readable."""
    from datetime import timedelta

    def provider(name):
        if name not in ok:
            return {"status": "unavailable", "reason": f"{name} /usage printed no quota windows.", "windows": {}}
        windows = {"5h": quota_window(five, now + timedelta(hours=2), now), "7d": quota_window(week, now + timedelta(days=4), now)}
        if name == "antigravity":
            windows["argon-7d"] = quota_window(0.0, now + timedelta(days=4), now, pool="Gemini 4 Argon")
        return {"status": "ok", "reason": None, "windows": windows}
    return {"schema_version": 1, "generated_at": now.isoformat(), "providers": {name: provider(name) for name in ("claude", "codex", "antigravity")}}

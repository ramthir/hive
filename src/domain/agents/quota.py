"""Current 5-hour and weekly quota windows of the coding agents, from a quota snapshot; independent of files and transport."""
from __future__ import annotations

from datetime import datetime, timedelta

PROVIDERS = ('claude', 'codex', 'antigravity')
WINDOWS = ('5h', '7d')
# Antigravity also reports Argon's weekly limit, which the page draws as its innermost ring.
PROVIDER_WINDOWS = {'claude': WINDOWS, 'codex': WINDOWS, 'antigravity': WINDOWS + ('argon-7d',)}
STALE_AFTER = timedelta(minutes=45)  # three collection intervals of 15 minutes
SCHEMA_VERSION = 1


class QuotaError(ValueError):
    """The quota snapshot is not usable."""


def _time(value, label):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError as exc:
        raise QuotaError(f'{label} is not an ISO timestamp.') from exc
    if parsed.tzinfo is None:
        raise QuotaError(f'{label} needs a timezone.')
    return parsed


def parse_snapshot(raw) -> dict:
    """Validate the snapshot the collector makes."""
    if not isinstance(raw, dict) or raw.get('schema_version') != SCHEMA_VERSION:
        raise QuotaError('Snapshot has an unsupported schema version.')
    providers = raw.get('providers')
    if not isinstance(providers, dict):
        raise QuotaError('Snapshot needs a providers object.')
    return {'generated_at': _time(raw.get('generated_at'), 'generated_at'), 'providers': providers}


def _window(entry, now: datetime, generated: datetime):
    """One window for the page: its state, used percent and reset time."""
    if not isinstance(entry, dict):
        return {'state': 'unavailable', 'used_pct': None, 'resets_at': None}
    resets = entry.get('resets_at')
    resets_at = _time(resets, 'resets_at').isoformat() if resets else None
    # A reading is only as fresh as when it was taken. Codex, for one, is read only while a session runs.
    taken = _time(entry['collected_at'], 'collected_at') if entry.get('collected_at') else generated
    if min(generated, taken) < now - STALE_AFTER:
        return {'state': 'stale', 'used_pct': None, 'resets_at': resets_at}
    if entry.get('status') == 'expired' or (resets_at and _time(resets, 'resets_at') <= now):
        return {'state': 'expired', 'used_pct': None, 'resets_at': resets_at}
    used = entry.get('used_pct')
    if entry.get('status') != 'ok' or not isinstance(used, (int, float)):
        return {'state': 'unavailable', 'used_pct': None, 'resets_at': resets_at}
    return {'state': 'ok', 'used_pct': float(used), 'resets_at': resets_at}


def build_view(snapshot: dict, now: datetime) -> dict:
    """Per-provider weekly and 5-hour windows, with the snapshot's age so the page can name staleness."""
    generated = snapshot['generated_at']
    providers = {}
    for name in PROVIDERS:
        provider = snapshot['providers'].get(name)
        if not isinstance(provider, dict) or provider.get('status') != 'ok':
            reason = provider.get('reason') if isinstance(provider, dict) else None
            providers[name] = {'status': 'unavailable', 'reason': reason or 'No quota source.',
                               'windows': {window: {'state': 'unavailable', 'used_pct': None, 'resets_at': None} for window in PROVIDER_WINDOWS[name]}}
            continue
        windows = provider.get('windows') if isinstance(provider.get('windows'), dict) else {}
        providers[name] = {'status': 'ok', 'reason': None,
                           'windows': {window: _window(windows.get(window), now, generated) for window in PROVIDER_WINDOWS[name]}}
    return {'generated_at': generated.isoformat(), 'stale': generated < now - STALE_AFTER, 'providers': providers}


def unavailable_view(reason: str) -> dict:
    return {'generated_at': None, 'stale': True, 'reason': reason,
            'providers': {name: {'status': 'unavailable', 'reason': reason,
                                 'windows': {window: {'state': 'unavailable', 'used_pct': None, 'resets_at': None} for window in PROVIDER_WINDOWS[name]}}
                          for name in PROVIDERS}}


class QuotaCollectError(RuntimeError):
    """The quota snapshot could not be made at all (one provider failing is not this: it shows as unavailable)."""

"""Current-month usage of the coding agents (Claude, Codex, Antigravity) from a ccusage report; independent of files and transport."""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PROVIDERS = ('claude', 'codex', 'antigravity')
STALE_AFTER = timedelta(minutes=45)  # three collection intervals
SESSION_SORTS = ('last_activity', 'provider', 'input', 'cached', 'output', 'total')
SESSION_DIRECTIONS = ('asc', 'desc')
MAX_PAGE_SIZE = 50
SCHEMA_VERSION = 1
TOKEN_KEYS = ('input', 'cached_input', 'cache_write', 'output')
_RAW_KEYS = ('inputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'outputTokens')


class ReportError(ValueError):
    """The report file is not a usable agent usage report."""


def _timestamp(value, label):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError as exc:
        raise ReportError(f'{label} is not an ISO timestamp.') from exc
    if parsed.tzinfo is None:
        raise ReportError(f'{label} needs a timezone.')
    return parsed


def parse_envelope(raw) -> dict:
    """Validate the wrapper the collector writes around ccusage's JSON."""
    if not isinstance(raw, dict) or raw.get('schema_version') != SCHEMA_VERSION:
        raise ReportError('Report has an unsupported schema version.')
    report = raw.get('report')
    if not isinstance(report, dict) or not isinstance(report.get('daily'), list) or not isinstance(report.get('session'), list):
        raise ReportError('Report needs daily and session lists.')
    try:
        since = datetime.strptime(str(raw.get('since')), '%Y-%m-%d').date()
    except ValueError as exc:
        raise ReportError('Report since must be YYYY-MM-DD.') from exc
    try:
        zone = ZoneInfo(str(raw.get('timezone')))
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ReportError('Report timezone is not a known IANA timezone.') from exc
    return {'generated_at': _timestamp(raw.get('generated_at'), 'generated_at'), 'since': since, 'zone': zone, 'report': report}


def normalize_tokens(row):
    """ccusage input excludes cache; task usage input includes cache reads and writes. None when unmeasured."""
    if not isinstance(row, dict) or any(type(row.get(key)) is not int or row[key] < 0 for key in _RAW_KEYS):
        return None
    cached, written = row['cacheReadTokens'], row['cacheCreationTokens']
    return {'input': row['inputTokens'] + cached + written, 'cached_input': cached, 'cache_write': written, 'output': row['outputTokens']}


def _add(total, tokens):
    for key in TOKEN_KEYS:
        total[key] += tokens[key]


def _with_total(tokens):
    return {**tokens, 'total': tokens['input'] + tokens['output']}


def _add_models(sums, breakdowns):
    """Adds a day's per-model counters; a model without a usable breakdown stays out of the sums."""
    for row in breakdowns if isinstance(breakdowns, list) else []:
        model = row.get('modelName') if isinstance(row, dict) else None
        tokens = normalize_tokens(row)
        if isinstance(model, str) and tokens is not None:
            _add(sums.setdefault(model, _empty()), tokens)


def _model_tokens(sums):
    """Each model's month tokens, largest total first, ties by name."""
    rows = [{'model': model, **_with_total(tokens)} for model, tokens in sums.items()]
    return sorted(rows, key=lambda row: (-row['total'], row['model']))


def _empty():
    return dict.fromkeys(TOKEN_KEYS, 0)


def _unavailable(status, reason, month=None):
    return {'status': status, 'reason': reason, 'month': month, 'generated_at': None, 'timezone': None,
            'providers': {name: {'status': status, 'reason': reason} for name in PROVIDERS}}


def unavailable_view(reason):
    return _unavailable('unavailable', reason)


def build_view(envelope: dict, now: datetime) -> dict:
    """Totals and the daily trend for the report's month, or a waiting view. Sessions come from session_page."""
    return _build(envelope, now)[0]


def _build(envelope: dict, now: datetime):
    """The view without sessions, and the month's sessions newest first."""
    zone = envelope['zone']
    local_now = now.astimezone(zone)
    month = local_now.strftime('%Y-%m')
    base = {'month': month, 'generated_at': envelope['generated_at'].isoformat(), 'timezone': str(zone)}
    since = envelope['since']
    if (since.year, since.month) != (local_now.year, local_now.month) or since.day != 1:
        view = _unavailable('waiting', "This month's report has not been generated yet.", month)
        return {**view, **base}, []
    stale = now - envelope['generated_at'] > STALE_AFTER
    providers = {name: {'status': 'no_usage', 'tokens': None, 'sessions': 0, 'models': [], 'model_tokens': [], 'daily': []} for name in PROVIDERS}
    model_sums = {name: {} for name in PROVIDERS}
    skipped = 0
    # Totals and the daily trend come from the daily report only, sessions from the session report only.
    for day in envelope['report']['daily']:
        agents = day.get('agents') if isinstance(day, dict) else None
        period = day.get('period') if isinstance(day, dict) else None
        if not isinstance(agents, list) or not isinstance(period, str):
            skipped += 1
            continue
        for agent in agents:
            name = agent.get('agent') if isinstance(agent, dict) else None
            tokens = normalize_tokens(agent)
            if name not in providers:
                continue
            if tokens is None or period < since.isoformat():
                skipped += tokens is None
                continue
            entry = providers[name]
            entry['status'] = 'available'
            entry['tokens'] = entry['tokens'] or _empty()
            _add(entry['tokens'], tokens)
            entry['daily'].append({'date': period, **_with_total(tokens)})
            entry['models'] = sorted({*entry['models'], *(agent.get('modelsUsed') or [])})
            _add_models(model_sums[name], agent.get('modelBreakdowns'))
    sessions, seen = [], set()
    for row in envelope['report']['session']:
        name = row.get('agent') if isinstance(row, dict) else None
        tokens = normalize_tokens(row)
        key = (name, row.get('period') if isinstance(row, dict) else None)
        if name not in providers or key in seen:
            continue
        if tokens is None:
            skipped += 1
            continue
        seen.add(key)
        providers[name]['sessions'] += 1
        last = (row.get('metadata') or {}).get('lastActivity')
        sessions.append({'provider': name, 'session': key[1], 'models': list(row.get('modelsUsed') or []),
                         'tokens': _with_total(tokens), 'last_activity': last})
    sessions.sort(key=lambda item: item['last_activity'] or '', reverse=True)
    for name, entry in providers.items():
        entry['model_tokens'] = _model_tokens(model_sums[name])
        entry['daily'].sort(key=lambda item: item['date'])
        if entry['tokens'] is not None:
            entry['tokens'] = _with_total(entry['tokens'])
    status = 'stale' if stale else 'ok'
    reason = 'The report is older than 45 minutes.' if stale else None
    covers = {'from': since.isoformat(), 'to': envelope['generated_at'].astimezone(zone).date().isoformat()}
    return {**base, 'status': status, 'reason': reason, 'covers': covers, 'providers': providers, 'skipped_rows': skipped}, sessions


def _validate_page(sort, direction, page, page_size):
    if sort not in SESSION_SORTS:
        raise ValueError(f"sort must be one of {', '.join(SESSION_SORTS)}.")
    if direction not in SESSION_DIRECTIONS:
        raise ValueError('dir must be asc or desc.')
    if type(page) is not int or page < 0:
        raise ValueError('page must be a whole number from 0.')
    if type(page_size) is not int or not 1 <= page_size <= MAX_PAGE_SIZE:
        raise ValueError(f'page_size must be from 1 to {MAX_PAGE_SIZE}.')


def _sort_value(item, key):
    if key == 'last_activity':
        return item['last_activity'] or ''
    if key == 'provider':
        return item['provider']
    return item['tokens']['cached_input' if key == 'cached' else key]


def empty_session_page(sort='last_activity', direction='desc', page=0, page_size=10):
    """A page with no sessions, for a month with no usable report."""
    _validate_page(sort, direction, page, page_size)
    return {'items': [], 'total': 0, 'page': page, 'page_size': page_size, 'sort': sort, 'dir': direction}


def session_page(envelope: dict, now: datetime, sort='last_activity', direction='desc', page=0, page_size=10) -> dict:
    """One page of the month's sessions, sorted across all of them; ties keep the newest first."""
    _validate_page(sort, direction, page, page_size)
    sessions = _build(envelope, now)[1]
    sessions.sort(key=lambda item: _sort_value(item, sort), reverse=direction == 'desc')
    start = page * page_size
    return {'items': sessions[start:start + page_size], 'total': len(sessions), 'page': page, 'page_size': page_size, 'sort': sort, 'dir': direction}


class CollectError(RuntimeError):
    """The usage report could not be produced (ccusage is missing, failed, timed out or printed something unusable)."""

"""Read the private OpenAI snapshot published by openai-usage-sync."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
from threading import Lock

LABEL_SUFFIX = re.compile(r'(-\d{4}-\d{2}-\d{2})?( (audio|text|image))?')
METRICS = ('input_tokens', 'input_cached_tokens', 'output_tokens', 'num_model_requests')


def month_bounds(month):
    if not re.fullmatch(r'\d{4}-\d{2}', month):
        raise ValueError('Month must be YYYY-MM')
    start = date.fromisoformat(month + '-01')
    return start, (start.replace(day=28) + timedelta(days=4)).replace(day=1)


def billed_model(line_item, models):
    """The usage model a billing line item belongs to: its label starts with the model name, then ', input' and so on.

    Billing labels sometimes carry a dated snapshot and a modality the usage model name lacks ('gpt-4o-mini-transcribe-2025-12-15 audio', 'gpt-realtime-2.1 text'). A bare prefix is not enough, since 'gpt-4.1' would claim 'gpt-4.1-mini' costs.
    """
    name = (line_item or '').split(', ')[0]
    if name in models:
        return name
    return next((m for m in models if name.startswith(m) and name != m and LABEL_SUFFIX.fullmatch(name[len(m):])), None)


def table_breakdowns(usage, costs, names, models):
    """Partition the same filtered records used for totals; preserve non-model costs."""
    groups = {}

    def group(pid, model):
        return groups.setdefault((pid, model), {**{m: 0 for m in METRICS}, 'costs': {}})

    for row in usage:
        result = group(row.get('project_id'), row.get('model') or 'Unattributed')
        for metric in METRICS:
            result[metric] += row.get(metric, 0)
    for row in costs:
        result = group(row.get('project_id'), billed_model(row.get('line_item'), models))
        currency = row['amount']['currency']
        result['costs'][currency] = result['costs'].get(currency, Decimal(0)) + Decimal(str(row['amount']['value']))
    by_project, by_model = {}, {}
    for (pid, model), values in groups.items():
        detail = {m: values[m] for m in METRICS}
        detail['costs'] = [{'currency': c, 'amount': str(v)} for c, v in sorted(values['costs'].items())]
        by_project.setdefault(pid, []).append({'model': model or 'Other billed items', 'billing_only': model is None, **detail})
        if model is not None:
            by_model.setdefault(model, []).append({'project_id': pid, 'name': names.get(pid, pid or 'Unattributed'), **detail})
    return by_project, by_model


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp requires a timezone')
    return parsed


def validate(data):
    if data.get('schema_version') != 1 or data.get('usage_scope') != 'completions':
        raise ValueError('Unsupported report format')
    timestamp(data['generated_at'])
    start, end = date.fromisoformat(data['start']), date.fromisoformat(data['end'])
    if start >= end:
        raise ValueError('Invalid report range')
    for project in data['projects']:
        if not isinstance(project['id'], str) or not isinstance(project['name'], str):
            raise ValueError('Invalid project')
    for dataset in ('costs', 'usage'):
        coverage = data['coverage'][dataset]
        if coverage['last_success_at']:
            timestamp(coverage['last_success_at'])
        for key in ('missing_days', 'stale_days'):
            if not isinstance(coverage[key], list):
                raise ValueError('Invalid coverage')
            for day in coverage[key]:
                date.fromisoformat(day)
        if not isinstance(data[dataset], list):
            raise ValueError('Invalid records')
        for row in data[dataset]:
            if not start <= date.fromisoformat(row['date']) < end:
                raise ValueError('Record outside report range')
            if row.get('project_id') is not None and not isinstance(row['project_id'], str):
                raise ValueError('Invalid project identity')
            if dataset == 'costs':
                value = Decimal(str(row['amount']['value']))
                if not value.is_finite() or not isinstance(row['amount']['currency'], str):
                    raise ValueError('Invalid amount')
                if row.get('line_item') is not None and not isinstance(row['line_item'], str):
                    raise ValueError('Invalid billing label')
            else:
                if row.get('model') is not None and not isinstance(row['model'], str):
                    raise ValueError('Invalid model')
                for metric in METRICS:
                    value = row.get(metric, 0)
                    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                        raise ValueError('Invalid metric')
    return data


class OpenAIReport:
    def __init__(self, path):
        self.path = Path(path)
        self._last_good = None
        self._lock = Lock()

    @staticmethod
    def _dashboard(data):
        token_keys = ('input_tokens', 'input_cached_tokens', 'output_tokens')
        def tokens(row):
            return {key: row.get(key, 0) for key in token_keys}
        result = {key: data[key] for key in ('month', 'status', 'message', 'last_success_at', 'totals')}
        result['models'] = [{'model': row['model'], **tokens(row),
            'num_model_requests': row.get('num_model_requests', 0), 'costs': row.get('costs', []),
            'projects': [{'name': part['name'], **tokens(part), 'costs': part.get('costs', [])}
                         for part in row.get('projects', [])]} for row in data.get('models', [])]
        result['project_costs'] = [{'name': row['name'], **tokens(row), 'costs': row.get('costs', []),
            'models': [{'model': part['model'], 'billing_only': part.get('billing_only', False),
                        **tokens(part), 'costs': part.get('costs', [])}
                       for part in row.get('models', [])]} for row in data.get('project_costs', [])]
        result['daily'] = [{'date': row['date'], 'currency': row['currency'], 'amount': row['amount'],
                           'projects': [{'name': part['name'], 'amount': part['amount']}
                                        for part in row.get('projects', [])]} for row in data.get('daily', [])]
        return result

    def view(self, month, project=None, now=None, dashboard=False):
        start, end = month_bounds(month)
        now = now or datetime.now(timezone.utc)
        issue = None
        with self._lock:
            try:
                data = validate(json.loads(self.path.read_text()))
                self._last_good = data
            except FileNotFoundError:
                issue = 'No OpenAI report is available yet. The daily sync has not published data.'
                data = self._last_good
            except (OSError, ValueError, KeyError, TypeError, AttributeError, InvalidOperation):
                issue = 'The OpenAI report could not be read. Showing the last valid snapshot when available.'
                data = self._last_good
        empty = {'month': month, 'status': 'unavailable', 'message': issue, 'last_success_at': None,
                 'projects': [], 'project': project, 'totals': [], 'project_costs': [],
                 'models': [], 'daily': [], 'usage_scope': 'completions', 'missing_days': []}
        if data is None:
            return self._dashboard(empty) if dashboard else empty
        names = {p['id']: p['name'] for p in data['projects']}
        cost_totals, project_costs, daily, models, line_costs = {}, {}, {}, {}, {}
        project_usage = {}
        daily_projects = {}
        filtered_usage, filtered_costs = [], []
        first, stop = max(start, date.fromisoformat(data['start'])), min(end, date.fromisoformat(data['end']), now.date() + timedelta(days=1))
        expected = set()
        day = start
        while day < min(end, now.date()):
            expected.add(day.isoformat())
            day += timedelta(days=1)
        missing = {d for d in expected if d < data['start'] or d >= data['end']}
        stale = False
        successes = []
        for coverage in data['coverage'].values():
            missing.update(expected.intersection(coverage['missing_days']))
            stale |= bool(expected.intersection(coverage['stale_days']))
            if coverage['last_success_at']:
                successes.append(timestamp(coverage['last_success_at']))
        last = min(successes) if len(successes) == 2 else None
        stale |= last is None or (now - last).total_seconds() >= 86400
        for row in data['costs']:
            if not first.isoformat() <= row['date'] < stop.isoformat() or (project and row.get('project_id') != project):
                continue
            filtered_costs.append(row)
            pid, currency = row.get('project_id'), row['amount']['currency']
            value = Decimal(str(row['amount']['value']))
            contributions = daily_projects.setdefault((row['date'], currency), {})
            contributions[pid] = contributions.get(pid, Decimal(0)) + value
            cost_totals[currency] = cost_totals.get(currency, Decimal(0)) + value
            for target, key in ((project_costs, (pid, currency)), (line_costs, (row.get('line_item'), currency)), (daily, (row['date'], currency))):
                target[key] = target.get(key, Decimal(0)) + value
        for row in data['usage']:
            if not first.isoformat() <= row['date'] < stop.isoformat() or (project and row.get('project_id') != project):
                continue
            filtered_usage.append(row)
            pid = row.get('project_id')
            project_total = project_usage.setdefault(pid, {m: 0 for m in METRICS})
            for metric in METRICS:
                project_total[metric] += row.get(metric, 0)
            model = row.get('model') or 'Unattributed'
            total = models.setdefault(model, {m: 0 for m in METRICS})
            for metric in METRICS:
                total[metric] += row.get(metric, 0)
        project_models, model_projects = table_breakdowns(filtered_usage, filtered_costs, names, models)
        project_rows = []
        project_ids = set(project_usage) | {pid for pid, _ in project_costs}
        for pid in project_ids:
            costs = [{'currency': currency, 'amount': str(value)}
                     for (cost_pid, currency), value in sorted(project_costs.items(), key=lambda item: item[0][1])
                     if cost_pid == pid]
            row = {'project_id': pid, 'name': names.get(pid, pid or 'Unattributed'),
                   'costs': costs, 'models': project_models.get(pid, []), **project_usage.get(pid, {m: 0 for m in METRICS})}
            if len(costs) == 1:
                row.update(costs[0])
            project_rows.append(row)
        project_rows.sort(key=lambda row: (-sum(Decimal(c['amount']) for c in row['costs']), row['name'], row['project_id'] or ''))
        model_costs = {}
        for (line_item, currency), value in line_costs.items():
            model = billed_model(line_item, models)
            if model:
                model_costs.setdefault(model, {})
                model_costs[model][currency] = model_costs[model].get(currency, Decimal(0)) + value
        status = 'error' if issue else 'incomplete' if missing or first >= stop else 'stale' if stale else 'ok'
        if status == 'ok' and not cost_totals and not models:
            status = 'empty'
        response = {**empty, 'status': status,
                'message': issue or {'incomplete': 'This month has incomplete sync coverage.', 'stale': 'The last successful sync is over 24 hours old.', 'empty': 'No usage or billed spend for these filters.'}.get(status),
                'last_success_at': last.isoformat() if last else None,
                'generated_at': data['generated_at'], 'missing_days': sorted(missing),
                'projects': [] if dashboard else sorted([{'id': k, 'name': v} for k, v in names.items()], key=lambda p: (p['name'], p['id'])),
                'totals': [{'currency': k, 'amount': str(v)} for k, v in sorted(cost_totals.items())],
                'project_costs': project_rows,
                'daily': [{'date': k, 'currency': c, 'amount': str(v),
                           'projects': [{'project_id': pid, 'name': names.get(pid, pid or 'Unattributed'), 'amount': str(amount)}
                                        for pid, amount in sorted(daily_projects[(k, c)].items(), key=lambda item: (-item[1], names.get(item[0], item[0] or 'Unattributed')))]}
                          for (k, c), v in sorted(daily.items())],
                'models': [{'model': k, **v, 'projects': model_projects.get(k, []), 'costs': [{'currency': c, 'amount': str(a)} for c, a in sorted(model_costs.get(k, {}).items())]} for k, v in sorted(models.items())]}

        return self._dashboard(response) if dashboard else response

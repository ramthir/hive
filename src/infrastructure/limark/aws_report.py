"""Validate and aggregate persisted AWS billing records without upstream access."""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
from threading import Lock
from zoneinfo import ZoneInfo

from .openai_report import month_bounds, timestamp


def amount(value):
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('Invalid reporting amount') from None
    if not result.is_finite():
        raise ValueError('Invalid reporting amount')
    return result


COST_CATEGORIES = ('EC2 & related', 'SageMaker', 'S3', 'Tax', 'Other')
EC2_SERVICES = frozenset({
    'Amazon Elastic Compute Cloud - Compute', 'EC2 - Other',
    'Amazon Virtual Private Cloud', 'Elastic Load Balancing',
    'Amazon Elastic Load Balancing',
})


def cost_category(service):
    if service in EC2_SERVICES:
        return 'EC2 & related'
    if service == 'Amazon SageMaker' or service.startswith('Amazon SageMaker '):
        return 'SageMaker'
    if service in {'Amazon Simple Storage Service', 'Amazon S3'}:
        return 'S3'
    if service.strip().lower() == 'tax':
        return 'Tax'
    return 'Other'


def validate(data):
    if data['schema_version'] not in (1, 2) or not re.fullmatch(r'\d{12}', data['account_id']):
        raise ValueError('Invalid snapshot identity')
    dashboard = data['schema_version'] == 2
    if dashboard and data.get('report_scope') != 'dashboard_costs':
        raise ValueError('Invalid compact snapshot scope')
    timestamp(data['last_success_at'])
    timestamp(data['generated_at'])
    start, end = date.fromisoformat(data['start']), date.fromisoformat(data['end'])
    if start >= end:
        raise ValueError('Invalid billing range')
    days = set()
    for period in data['coverage']:
        day = date.fromisoformat(period['date'])
        if not start <= day < end or period['date'] in days or not isinstance(period['estimated'], bool):
            raise ValueError('Invalid coverage')
        days.add(period['date'])
    keys = set()
    for row in data['records']:
        if row['date'] not in days:
            raise ValueError('Record outside coverage')
        for key in (('service', 'currency') if dashboard else ('service', 'usage_type', 'currency')):
            if not isinstance(row[key], str) or not row[key]:
                raise ValueError('Invalid billing label')
        amount(row['amount'])
        if dashboard:
            if set(row) != {'date', 'service', 'currency', 'amount'}:
                raise ValueError('Unexpected compact record fields')
        elif row['quantity'] is not None:
            amount(row['quantity'])
            if not isinstance(row['unit'], str) or not row['unit']:
                raise ValueError('Invalid usage unit')
        elif row['unit'] is not None:
            raise ValueError('Quantity missing for usage unit')
        key = tuple(row[k] for k in (('date', 'service', 'currency') if dashboard else ('date', 'service', 'usage_type', 'currency', 'unit')))
        if key in keys:
            raise ValueError('Duplicate billing record')
        keys.add(key)
    return data


class AWSReport:
    def __init__(self, path, fallback_path=None):
        self.path = Path(path)
        self.fallback_path = Path(fallback_path) if fallback_path else None
        self._last_source = self.path
        self._last_good = None
        self._lock = Lock()

    def _read(self):
        source = self.path
        try:
            raw = source.read_text()
        except FileNotFoundError:
            if self.fallback_path is None:
                raise
            source = self.fallback_path
            raw = source.read_text()
        return validate(json.loads(raw)), source

    @staticmethod
    def _dashboard(data):
        result = {key: data.get(key, []) if key == 'taxes' else data[key]
                  for key in ('month', 'status', 'message', 'account_id',
                              'totals', 'category_costs', 'daily', 'service_costs', 'taxes')}
        result['category_costs'] = [row for row in result['category_costs'] if row['category'] not in ('Other', 'Tax')]
        result['daily'] = [{**day, 'categories': [part for part in day['categories'] if amount(part['amount']) != 0]} for day in result['daily']]
        result['service_costs'] = [row for row in result['service_costs']
            if row['service'].strip().lower() != 'tax' and abs(amount(row['amount'])) >= Decimal('0.005')]
        return result

    def view(self, month, service=None, now=None, dashboard=False):
        first, stop = month_bounds(month)
        now = now or datetime.now(timezone.utc)
        issue = None
        with self._lock:
            try:
                data, source = self._read()
                self._last_good = data
                self._last_source = source
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                data = self._last_good
                issue = 'AWS snapshot unavailable or invalid. Showing the last valid data where available.'
        result = {'month': month, 'service': service, 'status': 'unavailable', 'message': issue,
                  'account_id': None, 'last_success_at': None, 'last_success_local': None,
                  'services': [], 'totals': [], 'category_costs': [], 'service_costs': [], 'taxes': [], 'usage': [], 'daily': [],
                  'explanations': [], 'missing_days': [], 'estimated': False,
                  'billing_timezone': 'UTC', 'schedule': '00:00 Asia/Colombo'}
        if data is None:
            return self._dashboard(result) if dashboard else result
        last = timestamp(data['last_success_at'])
        if last > now + timedelta(minutes=5):
            issue = 'The report has a future sync timestamp; check the collector clock.'
        attempt = None
        try:
            status_path = Path(str(self.path) + '.status.json')
            if not status_path.exists():
                status_path = Path(str(self._last_source) + '.status.json')
            attempt = json.loads(status_path.read_text())
            timestamp(attempt['last_attempt_at'])
            if attempt['ok'] is False:
                issue = 'The latest AWS collection failed. Showing the last successful snapshot.'
            elif attempt['ok'] is not True:
                raise ValueError('Invalid attempt status')
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError):
            issue = 'AWS collection status could not be read.'
            attempt = None
        expected = set()
        day = first
        while day < min(stop, now.date()):
            expected.add(day.isoformat())
            day += timedelta(days=1)
        coverage = {r['date']: r['estimated'] for r in data['coverage']}
        missing = sorted(expected - coverage.keys())
        rows = [r for r in data['records'] if first.isoformat() <= r['date'] < stop.isoformat()
                and (not service or r['service'] == service)]
        totals, services, daily, quantities = (defaultdict(Decimal) for _ in range(4))
        daily_categories = defaultdict(Decimal)
        unavailable = set()
        for row in rows:
            currency, value = row['currency'], amount(row['amount'])
            totals[currency] += value
            services[(row['service'], currency)] += value
            daily[(row['date'], currency)] += value
            daily_categories[(row['date'], currency, cost_category(row['service']))] += value
            if not dashboard and data['schema_version'] == 1:
                key = (row['service'], row['usage_type'], row['unit'])
                if row['quantity'] is None:
                    unavailable.add(key)
                else:
                    quantities[key] += amount(row['quantity'])
        categories = defaultdict(Decimal)
        taxes = defaultdict(Decimal)
        for (name, currency), value in services.items():
            categories[(cost_category(name), currency)] += value
            if name.strip().lower() == 'tax':
                taxes[currency] += value
        # Covered zero-activity days belong in the chart; uncovered days do not become zeros.
        currencies = sorted(totals)
        for day in sorted(expected & coverage.keys()):
            for currency in currencies:
                daily.setdefault((day, currency), Decimal(0))
        explanations = []
        for currency in ([] if dashboard else currencies):
            ranked = sorted(((s, v) for (s, c), v in services.items() if c == currency), key=lambda pair: (-pair[1], pair[0]))
            if ranked:
                name, value = ranked[0]
                explanations.append(f'{name} is the largest cost driver for {month}: {value:.2f} {currency} of {totals[currency]:.2f} {currency} net spend (including taxes and credits).')
            days = sorted(d for d in expected & coverage.keys())
            if len(days) >= 2 and date.fromisoformat(days[-1]) - date.fromisoformat(days[-2]) == timedelta(days=1):
                before, after = (daily.get((d, currency), Decimal(0)) for d in days[-2:])
                difference = after - before
                percent = f' ({difference / before * 100:+.1f}%)' if before > 0 else ''
                explanations.append(f'{days[-1]} versus {days[-2]} (UTC): {after:.2f} − {before:.2f} = {difference:+.2f} {currency}{percent}. Billing data describes the change; it does not establish its cause.')
        status = 'error' if issue else 'incomplete' if missing else 'stale' if (now-last).total_seconds() >= 86400 else 'ok' if rows else 'empty'
        response = {**result, 'status': status, 'message': issue or {
                    'incomplete': 'Some completed UTC billing days have not been collected.',
                    'stale': 'The last successful collection is at least 24 hours old.',
                    'empty': 'No AWS spending or usage for these filters.'}.get(status),
                'account_id': data['account_id'], 'last_success_at': last.isoformat(),
                'last_success_local': last.astimezone(ZoneInfo('Asia/Colombo')).isoformat(),
                'last_attempt_at': attempt.get('last_attempt_at') if attempt else None,
                'billing_start': data['start'], 'billing_end_exclusive': data['end'],
                'missing_days': missing, 'estimated': any(coverage.get(d, False) for d in expected),
                'services': [] if dashboard else sorted({r['service'] for r in data['records'] if first.isoformat() <= r['date'] < stop.isoformat()}),
                'totals': [{'currency': c, 'amount': str(v)} for c, v in sorted(totals.items())],
                'taxes': [{'currency': c, 'amount': str(taxes[c])} for c in currencies],
                'category_costs': [{'category': category, 'currency': currency,
                                    'amount': str(categories[(category, currency)])}
                                   for currency in currencies for category in COST_CATEGORIES],
                'service_costs': [{'service': s, 'currency': c, 'amount': str(v)} for (s, c), v in sorted(services.items(), key=lambda p: (p[0][1], -p[1], p[0][0]))],
                'daily': [{'date': d, 'currency': c, 'amount': str(v),
                           'categories': [{'category': category, 'amount': str(daily_categories[(d, c, category)])}
                                          for category in COST_CATEGORIES]}
                          for (d, c), v in sorted(daily.items())],
                'usage': [{'service': s, 'usage_type': t, 'unit': u, 'quantity': str(quantities[(s,t,u)]) if (s,t,u) in quantities else None}
                          for s,t,u in sorted(quantities.keys() | unavailable, key=lambda k: (k[0], k[1], k[2] or ''))],
                'explanations': explanations}
        return self._dashboard(response) if dashboard else response

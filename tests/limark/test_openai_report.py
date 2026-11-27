from datetime import datetime, timezone
import json

import pytest

from src.infrastructure.limark.openai_report import OpenAIReport, billed_model

NOW = datetime(2026, 9, 3, 12, tzinfo=timezone.utc)


def snapshot():
    return {'schema_version': 1, 'usage_scope': 'completions', 'generated_at': NOW.isoformat(),
            'start': '2026-09-01', 'end': '2026-09-04',
            'coverage': {kind: {'missing_days': [], 'stale_days': [], 'last_success_at': NOW.isoformat()} for kind in ('costs', 'usage')},
            'projects': [{'id': 'proj_a', 'name': 'Alpha'}, {'id': 'proj_b', 'name': 'Beta'}],
            'costs': [{'date': '2026-09-01', 'project_id': 'proj_a', 'line_item': 'gpt-test, input_tokens', 'amount': {'value': '1.10', 'currency': 'usd'}},
                      {'date': '2026-09-02', 'project_id': 'proj_b', 'line_item': 'storage', 'amount': {'value': '2.20', 'currency': 'usd'}},
                      {'date': '2026-09-02', 'project_id': None, 'line_item': None, 'amount': {'value': 4, 'currency': 'eur'}}],
            'usage': [{'date': '2026-09-01', 'project_id': 'proj_a', 'model': 'gpt-test', 'input_tokens': 100, 'input_cached_tokens': 40, 'output_tokens': 20, 'num_model_requests': 2}]}


@pytest.fixture
def report(tmp_path):
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(snapshot()))
    return OpenAIReport(path)


def test_monthly_totals_keep_currencies_and_datasets_separate(report):
    result = report.view('2026-09', now=NOW)
    assert result['status'] == 'ok'
    assert result['totals'] == [{'currency': 'eur', 'amount': '4'}, {'currency': 'usd', 'amount': '3.30'}]
    assert result['models'][0]['input_tokens'] == 100
    assert result['models'][0]['input_cached_tokens'] == 40
    assert 'billing_items' not in result
    assert result['models'][0]['costs'] == [{'currency': 'usd', 'amount': '1.10'}]
    assert result['last_success_at'] == NOW.isoformat()


def test_project_filter_applies_to_cost_and_usage(report):
    result = report.view('2026-09', 'proj_a', now=NOW)
    assert result['totals'] == [{'currency': 'usd', 'amount': '1.10'}]
    assert len(result['daily']) == 1
    assert report.view('2026-09', 'proj_b', now=NOW)['models'] == []
    assert report.view('2026-09', 'missing', now=NOW)['status'] == 'empty'


def test_uncached_month_and_partial_range_are_incomplete(report):
    assert report.view('2026-08', now=NOW)['status'] == 'incomplete'
    assert len(report.view('2026-08', now=NOW)['missing_days']) == 31
    assert report.view('2026-08', now=NOW)['totals'] == []


def test_age_causes_staleness_even_without_a_new_export(report):
    data = snapshot()
    data['end'] = '2026-09-05'
    report.path.write_text(json.dumps(data))
    assert report.view('2026-09', now=datetime(2026, 9, 4, 12, tzinfo=timezone.utc))['status'] == 'stale'


def test_missing_and_invalid_report_are_unavailable(tmp_path):
    reader = OpenAIReport(tmp_path / 'missing')
    assert reader.view('2026-09', now=NOW)['status'] == 'unavailable'
    reader.path.write_text('{broken')
    assert reader.view('2026-09', now=NOW)['status'] == 'unavailable'


def test_invalid_replacement_retains_last_good_data(report):
    before = report.view('2026-09', now=NOW)
    report.path.write_text('{broken')
    after = report.view('2026-09', now=NOW)
    assert after['status'] == 'error'
    assert after['totals'] == before['totals']
    report.path.unlink()
    assert report.view('2026-09', now=NOW)['totals'] == before['totals']


@pytest.mark.parametrize('change', ['nan', 'negative', 'timezone', 'range', 'version', 'missing'])
def test_invalid_snapshot_is_rejected(report, change):
    data = snapshot()
    if change == 'nan': data['costs'][0]['amount']['value'] = 'NaN'
    if change == 'negative': data['usage'][0]['input_tokens'] = -1
    if change == 'timezone': data['coverage']['costs']['last_success_at'] = '2026-09-03T12:00:00'
    if change == 'range': data['costs'][0]['date'] = '2026-08-01'
    if change == 'version': data['schema_version'] = 2
    if change == 'missing': del data['usage']
    report.path.write_text(json.dumps(data))
    assert report.view('2026-09', now=NOW)['status'] == 'unavailable'


@pytest.mark.parametrize('month', ['2026-13', '2026-9', '202609', 'bad'])
def test_invalid_month_is_refused(report, month):
    with pytest.raises(ValueError):
        report.view(month, now=NOW)


def test_empty_day_coverage_is_distinguished_from_missing(report):
    data = snapshot()
    data['costs'] = data['usage'] = []
    report.path.write_text(json.dumps(data))
    assert report.view('2026-09', now=NOW)['status'] == 'empty'
    data['coverage']['usage']['missing_days'] = ['2026-09-02']
    report.path.write_text(json.dumps(data))
    assert report.view('2026-09', now=NOW)['status'] == 'incomplete'


@pytest.mark.parametrize('line_item, model', [
    ('gpt-test, input_tokens', 'gpt-test'),
    ('gpt-test', 'gpt-test'),
    ('gpt-test-2026-03-17 audio, input', 'gpt-test'),
    ('gpt-test text, output', 'gpt-test'),
    ('gpt-test-mini, input', None),
    ('gpt-test-mini-2026-03-17, input', None),
    ('storage', None),
    (None, None),
])
def test_billing_line_items_belong_to_their_own_model_only(line_item, model):
    assert billed_model(line_item, {'gpt-test'}) == model


def test_model_without_a_billing_line_item_has_no_cost(report):
    data = snapshot()
    data['costs'][0]['line_item'] = 'other-model, input'
    report.path.write_text(json.dumps(data))
    assert report.view('2026-09', now=NOW)['models'][0]['costs'] == []


def test_project_usage_sums_models_and_days_without_adding_cached_input(report):
    data = snapshot()
    data['usage'].append({'date': '2026-09-02', 'project_id': 'proj_a', 'model': 'another-model',
                          'input_tokens': 200, 'input_cached_tokens': 60, 'output_tokens': 30, 'num_model_requests': 3})
    data['usage'].append({'date': '2026-09-02', 'project_id': 'proj_b', 'model': 'gpt-test',
                          'input_tokens': 7, 'input_cached_tokens': 2, 'output_tokens': 1, 'num_model_requests': 1})
    report.path.write_text(json.dumps(data))
    rows = {r['project_id']: r for r in report.view('2026-09', now=NOW)['project_costs']}
    assert [rows['proj_a'][key] for key in ('input_tokens', 'input_cached_tokens', 'output_tokens', 'num_model_requests')] == [300, 100, 50, 5]
    assert rows['proj_b']['input_tokens'] == 7
    filtered = report.view('2026-09', 'proj_b', now=NOW)['project_costs']
    assert len(filtered) == 1 and filtered[0]['num_model_requests'] == 1
    assert report.view('2026-08', now=NOW)['project_costs'] == []


def test_project_table_includes_usage_only_and_cost_only_projects(report):
    data = snapshot()
    data['usage'].append({'date': '2026-09-02', 'project_id': 'proj_usage_only', 'model': 'free-model',
                          'input_tokens': 10, 'output_tokens': 2, 'num_model_requests': 1})
    report.path.write_text(json.dumps(data))
    rows = {r['project_id']: r for r in report.view('2026-09', now=NOW)['project_costs']}
    assert rows['proj_usage_only']['costs'] == []
    assert rows['proj_usage_only']['input_tokens'] == 10
    assert rows['proj_usage_only']['input_cached_tokens'] == 0
    assert rows['proj_b']['input_tokens'] == rows['proj_b']['num_model_requests'] == 0
    assert rows['proj_b']['costs'] == [{'currency': 'usd', 'amount': '2.20'}]
    assert rows[None]['name'] == 'Unattributed'


def test_multiple_project_currencies_do_not_duplicate_usage_counts(report):
    data = snapshot()
    data['costs'].append({'date': '2026-09-02', 'project_id': 'proj_a', 'line_item': 'gpt-test',
                          'amount': {'value': '2.00', 'currency': 'eur'}})
    report.path.write_text(json.dumps(data))
    rows = report.view('2026-09', 'proj_a', now=NOW)['project_costs']
    assert len(rows) == 1
    assert rows[0]['input_tokens'] == 100
    assert rows[0]['costs'] == [{'currency': 'eur', 'amount': '2.00'}, {'currency': 'usd', 'amount': '1.10'}]


def test_model_tooltip_projects_reconcile_with_model_totals_and_respect_filters(report):
    data = snapshot()
    data['usage'].append({'date': '2026-09-02', 'project_id': 'proj_b', 'model': 'gpt-test',
                          'input_tokens': 50, 'input_cached_tokens': 20, 'output_tokens': 10, 'num_model_requests': 1})
    data['costs'].append({'date': '2026-09-02', 'project_id': 'proj_b', 'line_item': 'gpt-test, output_tokens',
                          'amount': {'currency': 'usd', 'value': '0.40'}})
    report.path.write_text(json.dumps(data))
    model = report.view('2026-09', now=NOW)['models'][0]
    assert {r['name'] for r in model['projects']} == {'Alpha', 'Beta'}
    for metric in ('input_tokens', 'input_cached_tokens', 'output_tokens', 'num_model_requests'):
        assert sum(r[metric] for r in model['projects']) == model[metric]
    assert [r['costs'] for r in model['projects']] == [[{'currency': 'usd', 'amount': '1.10'}], [{'currency': 'usd', 'amount': '0.40'}]]
    filtered = report.view('2026-09', 'proj_b', now=NOW)['models'][0]
    assert len(filtered['projects']) == 1 and filtered['projects'][0]['project_id'] == 'proj_b'
    assert filtered['input_tokens'] == 50


def test_project_tooltip_keeps_non_model_costs_and_currency_totals(report):
    data = snapshot()
    data['costs'].append({'date': '2026-09-02', 'project_id': 'proj_a', 'line_item': 'storage',
                          'amount': {'currency': 'eur', 'value': '-2.00'}})
    report.path.write_text(json.dumps(data))
    row = report.view('2026-09', 'proj_a', now=NOW)['project_costs'][0]
    assert {r['model'] for r in row['models']} == {'gpt-test', 'Other billed items'}
    other = next(r for r in row['models'] if r['billing_only'])
    assert other['input_tokens'] == 0
    assert other['costs'] == [{'currency': 'eur', 'amount': '-2.00'}]
    for metric in ('input_tokens', 'input_cached_tokens', 'output_tokens', 'num_model_requests'):
        assert sum(r[metric] for r in row['models']) == row[metric]


def test_unattributed_project_and_missing_cost_breakdowns_are_retained(report):
    data = snapshot()
    data['costs'] = []
    data['usage'][0]['project_id'] = None
    report.path.write_text(json.dumps(data))
    model = report.view('2026-09', now=NOW)['models'][0]
    assert model['projects'][0]['name'] == 'Unattributed'
    assert model['projects'][0]['costs'] == []
    assert report.view('2026-08', now=NOW)['models'] == []


def test_daily_project_breakdown_aggregates_line_items_and_reconciles_per_currency(report):
    from decimal import Decimal
    data = snapshot()
    data['costs'].extend([
        {'date': '2026-09-01', 'project_id': 'proj_a', 'line_item': 'gpt-test, output', 'amount': {'currency': 'usd', 'value': '0.90'}},
        {'date': '2026-09-01', 'project_id': 'proj_b', 'line_item': 'storage', 'amount': {'currency': 'usd', 'value': '-0.50'}},
        {'date': '2026-09-01', 'project_id': 'proj_b', 'line_item': 'storage', 'amount': {'currency': 'eur', 'value': '4.00'}},
    ])
    report.path.write_text(json.dumps(data))
    days = report.view('2026-09', now=NOW)['daily']
    usd = next(day for day in days if day['date'] == '2026-09-01' and day['currency'] == 'usd')
    assert usd['amount'] == '1.50'
    assert usd['projects'] == [{'project_id': 'proj_a', 'name': 'Alpha', 'amount': '2.00'}, {'project_id': 'proj_b', 'name': 'Beta', 'amount': '-0.50'}]
    for day in days:
        assert sum(Decimal(p['amount']) for p in day['projects']) == Decimal(day['amount'])
    assert next(day for day in days if day['date'] == '2026-09-02' and day['currency'] == 'eur')['projects'][0]['name'] == 'Unattributed'
    filtered = report.view('2026-09', 'proj_a', now=NOW)['daily']
    assert len(filtered) == 1 and filtered[0]['amount'] == '2.00'
    assert len(filtered[0]['projects']) == 1
    assert report.view('2026-08', now=NOW)['daily'] == []


@pytest.mark.parametrize('project',[None,'proj_a','proj_b'])
def test_compact_openai_view_preserves_rendered_data_without_selector_metadata(report,project):
    full=report.view('2026-09',project,now=NOW)
    compact=report.view('2026-09',project,now=NOW,dashboard=True)
    assert set(compact)=={'month','status','message','last_success_at','totals','models','project_costs','daily'}
    assert compact['totals']==full['totals']
    for key in ('models','project_costs','daily'):assert len(compact[key])==len(full[key])
    assert compact['last_success_at']==full['last_success_at']
    assert 'projects' not in compact and 'project' not in compact and 'missing_days' not in compact
    for row,original in zip(compact['models'],full['models']):
        assert row['input_tokens']==original['input_tokens']
        assert row['num_model_requests']==original['num_model_requests']
        assert row['costs']==original['costs']
        assert all('project_id' not in item for item in row['projects'])
    for row,original in zip(compact['project_costs'],full['project_costs']):
        assert row['name']==original['name'] and row['costs']==original['costs']
        assert 'project_id' not in row and 'num_model_requests' not in row
    for row,original in zip(compact['daily'],full['daily']):
        assert row['amount']==original['amount']
        assert [item['amount'] for item in row['projects']]==[item['amount'] for item in original['projects']]
        assert all(set(item)=={'name','amount'} for item in row['projects'])


def test_compact_openai_unavailable_and_last_good_states(tmp_path):
    path=tmp_path/'report.json';reader=OpenAIReport(path)
    assert reader.view('2026-09',now=NOW,dashboard=True)['status']=='unavailable'
    path.write_text(json.dumps(snapshot()))
    before=reader.view('2026-09',now=NOW,dashboard=True)
    path.write_text('{}')
    after=reader.view('2026-09',now=NOW,dashboard=True)
    assert after['status']=='error' and after['totals']==before['totals']


def test_in_progress_utc_day_is_not_reported_as_a_gap(report):
    data = snapshot()
    data['end'] = '2026-09-03'
    report.path.write_text(json.dumps(data))
    result = report.view('2026-09', now=NOW)
    assert result['status'] == 'ok'
    assert result['missing_days'] == []


def test_missing_completed_day_is_still_reported_incomplete(report):
    data = snapshot()
    data['end'] = '2026-09-02'
    data['costs'] = [row for row in data['costs'] if row['date'] < '2026-09-02']
    report.path.write_text(json.dumps(data))
    result = report.view('2026-09', now=NOW)
    assert result['status'] == 'incomplete'
    assert result['missing_days'] == ['2026-09-02']

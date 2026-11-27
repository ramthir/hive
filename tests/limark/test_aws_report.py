from datetime import datetime, timezone
import json

import pytest

from src.infrastructure.limark.aws_report import AWSReport

NOW = datetime(2026, 10, 3, 0, tzinfo=timezone.utc)


def snapshot():
    return {'schema_version': 1, 'account_id': '123456789012', 'generated_at': NOW.isoformat(),
            'last_success_at': NOW.isoformat(), 'start': '2026-10-01', 'end': '2026-10-03',
            'coverage': [{'date': f'2026-10-0{i}', 'estimated': True} for i in (1, 2)],
            'records': [dict(date=day, service=s, usage_type=t, amount=a, currency='USD', quantity=q, unit=u)
                        for day, s, t, a, q, u in [
                            ('2026-10-01','EC2','Hours','10','2','Hrs'),
                            ('2026-10-02','EC2','Hours','15','3','Hrs'),
                            ('2026-10-02','EC2','Transfer','2','5','GB'),
                            ('2026-10-02','Tax','Tax','1',None,None),
                            ('2026-10-02','EC2','Credit','-3',None,None)]]}


def reader(tmp_path):
    path = tmp_path / 'aws.json'
    path.write_text(json.dumps(snapshot()))
    return AWSReport(path), path


def test_totals_filter_units_and_explanations(tmp_path):
    report, _ = reader(tmp_path)
    data = report.view('2026-10', now=NOW)
    assert data['status'] == 'ok'
    assert data['totals'] == [{'currency': 'USD', 'amount': '25'}]
    assert data['taxes'] == [{'currency': 'USD', 'amount': '1'}]
    assert data['estimated']
    assert data['last_success_local'].endswith('+05:30')
    assert data['daily'][-1]['amount'] == '15'
    assert '15.00 − 10.00 = +5.00 USD (+50.0%)' in data['explanations'][-1]
    usage = {r['unit']: r['quantity'] for r in data['usage'] if r['quantity'] is not None}
    assert usage == {'Hrs': '5', 'GB': '5'}
    filtered = report.view('2026-10', 'EC2', now=NOW)
    assert filtered['totals'][0]['amount'] == '24'
    assert all(r['service'] == 'EC2' for r in filtered['usage'])
    assert report.view('2026-10', 'unknown', now=NOW)['status'] == 'empty'


def test_missing_stale_corrupt_and_failure_preservation(tmp_path):
    report, path = reader(tmp_path)
    assert report.view('2026-10', now=NOW)['status'] == 'ok'
    path.write_text('{}')
    data = report.view('2026-10', now=NOW)
    assert data['status'] == 'error' and data['totals'][0]['amount'] == '25'
    assert AWSReport(path).view('2026-10', now=NOW)['status'] == 'unavailable'
    path.write_text(json.dumps(snapshot()))
    assert report.view('2026-09', now=NOW)['status'] == 'incomplete'
    assert report.view('2026-10', now=datetime(2026,10,4,tzinfo=timezone.utc))['status'] == 'incomplete'
    assert report.view('2026-10', now=datetime(2026,10,3,23,59,tzinfo=timezone.utc))['status'] == 'ok'
    Path = type(path)
    Path(str(path) + '.status.json').write_text(json.dumps({'ok': False, 'last_attempt_at': NOW.isoformat()}))
    assert report.view('2026-10', now=NOW)['status'] == 'error'


@pytest.mark.parametrize('mutation', ['duplicate', 'nan', 'unit', 'coverage'])
def test_invalid_snapshot_is_rejected(tmp_path, mutation):
    data = snapshot()
    if mutation == 'duplicate': data['records'].append(data['records'][0])
    if mutation == 'nan': data['records'][0]['amount'] = 'NaN'
    if mutation == 'unit': data['records'][0]['unit'] = None
    if mutation == 'coverage': data['coverage'] = []
    path = tmp_path / 'aws.json'; path.write_text(json.dumps(data))
    assert AWSReport(path).view('2026-10', now=NOW)['status'] == 'unavailable'


def test_zero_comparison_missing_usage_and_stale(tmp_path):
    data = snapshot()
    data['records'] = [r for r in data['records'] if r['date'] != '2026-10-01']
    data['last_success_at'] = '2026-10-02T00:00:00+00:00'
    path = tmp_path / 'aws.json'; path.write_text(json.dumps(data))
    result = AWSReport(path).view('2026-10', now=NOW)
    assert result['status'] == 'stale'
    assert '%' not in result['explanations'][-1]
    assert any(r['quantity'] is None for r in result['usage'])


@pytest.mark.parametrize('month', ['bad', '2026-13', '2026-1'])
def test_invalid_month(tmp_path, month):
    with pytest.raises(ValueError): AWSReport(tmp_path/'none').view(month)


def test_category_cards_partition_costs_preserve_credits_and_currencies(tmp_path):
    from decimal import Decimal
    from src.infrastructure.limark.aws_report import cost_category
    data = snapshot()
    services = [
        ('Amazon Elastic Compute Cloud - Compute', '10', 'USD'),
        ('EC2 - Other', '2', 'USD'), ('Amazon Virtual Private Cloud', '3', 'USD'),
        ('Elastic Load Balancing', '4', 'USD'), ('Amazon SageMaker', '20', 'USD'),
        ('Amazon Simple Storage Service', '5', 'USD'), ('Tax', '1', 'USD'),
        ('AWS Lambda', '-2', 'USD'), ('Amazon EC2 Container Registry (ECR)', '6', 'USD'),
        ('Amazon SageMaker', '7', 'EUR')]
    data['records'] = [dict(date='2026-10-01', service=s, usage_type='billing', amount=a,
                            currency=c, quantity=None, unit=None) for s,a,c in services]
    path = tmp_path/'aws.json'; path.write_text(json.dumps(data))
    report = AWSReport(path)
    result = report.view('2026-10', now=NOW)
    cards = {(r['category'],r['currency']):r['amount'] for r in result['category_costs']}
    assert cards[('EC2 & related','USD')] == '19'
    assert cards[('SageMaker','USD')] == '20'
    assert cards[('S3','USD')] == '5'
    assert cards[('Tax','USD')] == '1'
    assert cards[('Other','USD')] == '4'
    assert cards[('SageMaker','EUR')] == '7'
    assert cards[('EC2 & related','EUR')] == '0'
    for total in result['totals']:
        assert sum(Decimal(r['amount']) for r in result['category_costs'] if r['currency']==total['currency']) == Decimal(total['amount'])
    filtered = report.view('2026-10','Amazon Simple Storage Service',now=NOW)
    assert [r['amount'] for r in filtered['category_costs']] == ['0','0','5','0','0']
    assert cost_category('Tax') == 'Tax'
    assert cost_category('tax') == 'Tax'
    assert cost_category('Amazon EC2 Container Registry (ECR)') == 'Other'
    assert cost_category('Unknown service') == 'Other'
    assert report.view('2026-09',now=NOW)['category_costs'] == []


def test_daily_stacks_reconcile_by_currency_filter_and_credits(tmp_path):
    from decimal import Decimal
    data = snapshot()
    data['records'][0]['service'] = 'Amazon Elastic Compute Cloud - Compute'
    data['records'][1]['service'] = 'Amazon SageMaker'
    data['records'][2]['service'] = 'Amazon Simple Storage Service'
    path = tmp_path/'aws.json'; path.write_text(json.dumps(data))
    report = AWSReport(path)
    result = report.view('2026-10', now=NOW)
    for day in result['daily']:
        assert sum(Decimal(c['amount']) for c in day['categories']) == Decimal(day['amount'])
    day = result['daily'][-1]
    parts = {part['category']: part['amount'] for part in day['categories']}
    assert parts == {'EC2 & related':'0','SageMaker':'15','S3':'2','Tax':'1','Other':'-3'}
    filtered = report.view('2026-10','Amazon Simple Storage Service',now=NOW)
    assert filtered['daily'][-1]['categories'] == [
        {'category':'EC2 & related','amount':'0'}, {'category':'SageMaker','amount':'0'},
        {'category':'S3','amount':'2'}, {'category':'Tax','amount':'0'}, {'category':'Other','amount':'0'}]
    assert filtered['daily'][0]['amount'] == '0'
    assert all(c['amount']=='0' for c in filtered['daily'][0]['categories'])


def compact_snapshot(data):
    from collections import defaultdict
    from decimal import Decimal
    grouped=defaultdict(Decimal)
    for row in data['records']:grouped[(row['date'],row['service'],row['currency'])]+=Decimal(row['amount'])
    return {**data,'schema_version':2,'report_scope':'dashboard_costs','records':[
        {'date':d,'service':service,'currency':currency,'amount':str(value)}
        for (d,service,currency),value in grouped.items()]}


def test_compact_view_matches_full_and_v2_snapshots(tmp_path):
    full,path=reader(tmp_path)
    expected=full.view('2026-10',now=NOW)
    minimal=full.view('2026-10',now=NOW,dashboard=True)
    assert set(minimal)=={'month','status','message','account_id','totals','category_costs','daily','service_costs','taxes'}
    assert minimal==AWSReport._dashboard(expected)
    assert minimal['taxes']==[{'currency':'USD','amount':'1'}]
    assert all(row['category']!='Other' for row in minimal['category_costs'])
    assert all(row['service']!='Tax' for row in minimal['service_costs'])
    assert all(part['amount']!='0' for day in minimal['daily'] for part in day['categories'])
    path.write_text(json.dumps(compact_snapshot(snapshot())))
    assert AWSReport(path).view('2026-10',now=NOW,dashboard=True)==minimal
    assert all(key not in minimal for key in ('usage','explanations','services','last_success_at','missing_days'))


def test_compact_legacy_fallback_and_last_good(tmp_path):
    _,legacy=reader(tmp_path); compact=tmp_path/'dashboard.json'
    report=AWSReport(compact,fallback_path=legacy)
    assert report.view('2026-10',now=NOW,dashboard=True)['status']=='ok'
    status=tmp_path/'dashboard.json.status.json'
    status.write_text(json.dumps({'ok':False,'last_attempt_at':NOW.isoformat()}))
    assert report.view('2026-10',now=NOW,dashboard=True)['status']=='error'
    status.unlink()
    compact.write_text(json.dumps(compact_snapshot(snapshot())))
    legacy.unlink()
    assert report.view('2026-10',now=NOW,dashboard=True)['status']=='ok'
    compact.write_text('{}')
    result=report.view('2026-10',now=NOW,dashboard=True)
    assert result['status']=='error' and result['totals'][0]['amount']=='25'
    assert AWSReport(tmp_path/'none').view('2026-10',now=NOW,dashboard=True)['status']=='unavailable'


@pytest.mark.parametrize('mutation',['scope','unexpected','duplicate','amount'])
def test_bad_compact_snapshots_refused(tmp_path,mutation):
    data=compact_snapshot(snapshot())
    if mutation=='scope':data['report_scope']='general'
    if mutation=='amount':data['records'][0]['amount']='invalid'
    if mutation=='unexpected':data['records'][0]['unit']='Hrs'
    if mutation=='duplicate':data['records'].append(data['records'][0])
    path=tmp_path/'bad.json';path.write_text(json.dumps(data))
    assert AWSReport(path).view('2026-10',now=NOW,dashboard=True)['status']=='unavailable'

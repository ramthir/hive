import test from 'node:test';
import assert from 'node:assert/strict';
import { reportUrl, renderReport, serviceDisplayName, serviceTable, fillTables, reconciliationSummary } from '../../static/limark/aws-format.js';
const data = { month: '2026-10', account_id: '123456789012', last_success_local: '2026-10-03T05:30:00+05:30', billing_start: '2026-10-01', billing_end_exclusive: '2026-10-03', estimated: true, totals: [{amount:'-2',currency:'USD'}], category_costs: [{category:'EC2 & related',amount:'0',currency:'USD'},{category:'SageMaker',amount:'0',currency:'USD'},{category:'S3',amount:'0',currency:'USD'},{category:'Other',amount:'-2',currency:'USD'}], daily:[{date:'2026-10-01',amount:'-2',currency:'USD',categories:[{category:'Other',amount:'-2'}]}], service_costs:[{service:'<script>',amount:'-2',currency:'USD'}], usage:[{service:'EC2',usage_type:'Hours',quantity:null,unit:null}], explanations:['<script>alert(1)</script>'] };
test('filter URL preserves arbitrary service names', () => {
  const url = new URL(reportUrl('2026-10', 'EC2 & Tax'), 'http://pandora');
  assert.equal(url.searchParams.get('service'), 'EC2 & Tax');
  assert.equal(url.searchParams.get('view'), 'dashboard');
});
test('report explains units, freshness and credits without HTML injection', () => {
  const html = renderReport(data);
  assert.doesNotMatch(html, /Last successful collection:|Scheduled daily at|Billing coverage:|Account 123456789012/);
  assert.match(html, /October 2026/);
  assert.doesNotMatch(html, /Estimated figures may change/);
  assert.doesNotMatch(html, /Usage by billing unit/);
  assert.match(html, /-2.00 USD/);
  assert.match(html, /fill aws-other/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(serviceTable(data).columns[0].render('<script>'), '&lt;script&gt;');
});
test('unavailable and empty reports are explicit', () => {
  assert.match(renderReport({...data, account_id:null, message:'Missing'}), /Awaiting/);
  assert.match(renderReport({...data, totals:[], daily:[], service_costs:[], usage:[], explanations:[]}), /No daily spend/);
});

test('top cards show all four categories with explicit inclusion labels', () => {
  const html = renderReport(data);
  assert.equal((html.match(/<stat-card /g) || []).length, 4);
  for (const title of ['EC2 & related', 'SageMaker', 'S3', 'Total']) assert.ok(html.includes(`title="${title.replace('&', '&amp;')}"`));
  assert.match(html, /Compute, storage &amp; add-ons, VPC and load balancing/);
  assert.match(html, /All services, including taxes and credits/);
  assert.match(html, /title="Total"[^>]*value="-2.00 USD"/);
  assert.doesNotMatch(html, /title="Other"/);
  assert.doesNotMatch(renderReport({...data, account_id:null}), /<stat-card /);
});

test('collection errors remain visible after metadata paragraphs are removed', () => {
  assert.match(renderReport({...data, message:'The latest AWS collection failed.'}), /The latest AWS collection failed/);
});

test('AWS reuses the OpenAI month chart with full month bars and shared tooltips', () => {
  const html = renderReport(data);
  assert.match(html, /<h3>October 2026<\/h3>/);
  assert.equal((html.match(/class="bar"/g) || []).length, 31);
  assert.match(html, /class="axis"/);
  assert.match(html, /data-tooltip-details=/);
  assert.doesNotMatch(html, /Daily spend ·|aws-trend/);
  const empty = renderReport({...data, daily:[]});
  assert.match(empty, /No daily spend for this selection/);
});

test('AWS omits the What changed section and its generated explanations', () => {
  const html = renderReport({...data, explanations:['SageMaker is the largest cost driver', 'Daily comparison text']});
  assert.doesNotMatch(html, /What changed|largest cost driver|Daily comparison text/);
  assert.match(html, /aria-label="Service costs"/);
  assert.doesNotMatch(html, /Usage by billing unit/);
});

test('AWS category stacks use distinct colors and reconcile their tooltip total', () => {
  const categories = [{category:'EC2 & related',amount:'10'},{category:'S3',amount:'2'},{category:'SageMaker',amount:'3'},{category:'Other',amount:'-1'}];
  const html = renderReport({...data, daily:[{date:'2026-10-01',currency:'USD',amount:'14',categories}]});
  for (const key of ['ec2','s3','sagemaker','other']) assert.match(html, new RegExp(`class="fill aws-${key}"`));
  const encoded = /data-tooltip-details="([^"]+)"/.exec(html)[1];
  const details = JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(details.map(d => d.label), ['EC2 & related','S3','SageMaker','Other','Total']);
  assert.deepEqual(details.map(d => d.value), ['$10.00','$2.00','$3.00','-$1.00','$14.00']);
  assert.match(html, /-\$[0-9]/); // signed axis exposes credit side
  assert.equal((html.match(/tabindex="0" data-tooltip-title=/g) || []).length, 1);
  const cancel = renderReport({...data, daily:[{date:'2026-10-01',currency:'USD',amount:'0',categories:[{category:'S3',amount:'2'},{category:'Other',amount:'-2'}]}]});
  assert.match(cancel, /data-tooltip-details=/);
  assert.match(cancel, /fill aws-s3/);
  assert.match(cancel, /fill aws-other/);
});

test('EC2 & related display label and tooltip omits zero categories but retains the total', () => {
  const html = renderReport({...data, daily:[{date:'2026-10-01',currency:'USD',amount:'0',categories:[{category:'EC2 & related',amount:'2'},{category:'S3',amount:'0'},{category:'SageMaker',amount:'0.000'},{category:'Other',amount:'-2'}]}]});
  assert.match(html, /title="EC2 &amp; related"/);
  const encoded = /data-tooltip-details="([^"]+)"/.exec(html)[1];
  const details = JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(details.map(d => d.label), ['EC2 & related','Other','Total']);
  assert.deepEqual(details.map(d => d.value), ['$2.00','-$2.00','$0.00']);
});

test('stacked chart legend shares the heading row', () => {
  const html = renderReport(data);
  assert.match(html, /class="panel-head"><h3>October 2026<\/h3><ul class="chart-legend"/);
  for (const cat of ['EC2 & related', 'S3', 'SageMaker', 'Tax', 'Other']) {
    const escaped = cat.replace('&', '&amp;');
    assert.match(html, new RegExp(`<li><span class="legend-swatch aws-${cat === 'EC2 & related' ? 'ec2' : cat.toLowerCase()}"[^>]*><\/span>${escaped}<\/li>`));
  }
});

test('AWS daily chart stacks Tax as a dedicated category and includes it in tooltips when nonzero', () => {
  const categories = [
    { category: 'EC2 & related', amount: '5' },
    { category: 'S3', amount: '1' },
    { category: 'SageMaker', amount: '10' },
    { category: 'Tax', amount: '39.03' },
    { category: 'Other', amount: '2' },
  ];
  const html = renderReport({ ...data, daily: [{ date: '2026-10-01', currency: 'USD', amount: '57.03', categories }] });
  for (const key of ['ec2', 's3', 'sagemaker', 'tax', 'other']) {
    assert.match(html, new RegExp(`class="fill aws-${key}"`));
  }
  assert.match(html, /class="legend-swatch aws-tax"/);
  const encoded = /data-tooltip-details="([^"]+)"/.exec(html)[1];
  const details = JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(details.map(d => d.label), ['EC2 & related', 'S3', 'SageMaker', 'Tax', 'Other', 'Total']);
  assert.deepEqual(details.map(d => d.value), ['$5.00', '$1.00', '$10.00', '$39.03', '$2.00', '$57.03']);

  // When Tax is 0, it is omitted from the tooltip and has no fill
  const zeroTaxHtml = renderReport({
    ...data,
    daily: [{ date: '2026-10-02', currency: 'USD', amount: '18.00', categories: [
      { category: 'EC2 & related', amount: '5' },
      { category: 'S3', amount: '1' },
      { category: 'SageMaker', amount: '10' },
      { category: 'Tax', amount: '0' },
      { category: 'Other', amount: '2' },
    ]}],
  });
  const zeroEncoded = /data-tooltip-details="([^"]+)"/.exec(zeroTaxHtml)[1];
  const zeroDetails = JSON.parse(zeroEncoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(zeroDetails.map(d => d.label), ['EC2 & related', 'S3', 'SageMaker', 'Other', 'Total']);
  assert.doesNotMatch(zeroTaxHtml, /class="fill aws-tax"/);
});

test('AWS retains an accessible service cost table without section headings or usage table', () => {
  const html = renderReport(data);
  assert.match(html, /aria-label="Service costs"/);
  assert.deepEqual(serviceTable(data).columns.map(c => c.label), ['Service','Cost']);
  assert.match(html, /<app-table data-report="services"/);
  assert.doesNotMatch(html, /<h2>Cost by service|Usage by billing unit|Usage type/);
  assert.equal((html.match(/<app-table /g) || []).length, 1);
  assert.doesNotMatch(html, /<table /);
});

test('service table uses the shared component API with sorting, numeric alignment and empty state', () => {
  const calls = {};
  const table = {setColumns: v => calls.columns=v, setEmptyState:v => calls.empty=v, setData:v => calls.rows=v};
  fillTables({querySelector:()=>table},data);
  assert.deepEqual(calls.rows,data.service_costs);
  assert.ok(calls.columns.every(c=>c.sortable));
  assert.equal(calls.columns[1].className,'num');
  assert.equal(calls.columns[1].sortValue('10.2'),10.2);
  assert.equal(calls.columns[1].render('-2',{currency:'USD'}),'-$2.00');
  assert.match(calls.empty.title,/No service costs/);
  fillTables({querySelector:()=>table},{service_costs:[]});
  assert.deepEqual(calls.rows,[]);
  assert.doesNotThrow(()=>fillTables({querySelector:()=>null},{}));
});

test('service table hides only zero amounts and retains charges and credits', () => {
  const rows = [{service:'zero',amount:'0',currency:'USD'}, {service:'negative zero',amount:'-0.000',currency:'USD'}, {service:'charge',amount:'2',currency:'USD'}, {service:'credit',amount:'-1',currency:'USD'}];
  assert.deepEqual(serviceTable({service_costs:rows}).rows.map(r=>r.service), ['charge','credit']);
  assert.deepEqual(serviceTable({service_costs:rows.slice(0,2)}).rows, []);
});
test('AWS tooltip anchor follows the actual colored stack height', () => {
  const html = renderReport({...data,daily:[{date:'2026-10-01',currency:'USD',amount:'2',categories:[{category:'S3',amount:'2'}]},{date:'2026-10-02',currency:'USD',amount:'10',categories:[{category:'S3',amount:'10'}]}]});
  assert.match(html, /data-tooltip-anchor=".bar-anchor"/);
  assert.match(html, /class="bar-anchor" style="bottom:0.0000%;height:20.0000%"/);
  assert.doesNotMatch(html, /data-tooltip-anchor=".stack"/);
});

test('S3 summary card uses the folder icon', () => {
  assert.match(renderReport(data), /title="S3" icon="fa-solid fa-folder"/);
});

test('service costs have grouping and exactly two decimals and omit amounts rounding to zero', () => {
  const model = serviceTable({service_costs:[
    {service:'tiny',amount:'0.0049',currency:'USD'},
    {service:'tiny credit',amount:'-0.0049',currency:'USD'},
    {service:'boundary',amount:'0.005',currency:'USD'},
    {service:'large',amount:'1234.56789',currency:'USD'},
    {service:'credit',amount:'-12.34567',currency:'USD'},
  ]});
  assert.deepEqual(model.rows.map(r=>r.service),['boundary','large','credit']);
  const render = model.columns[1].render;
  assert.equal(render('1234.56789',{currency:'USD'}),'$1,234.57');
  assert.equal(render('-12.34567',{currency:'USD'}),'-$12.35');
  assert.equal(render('0.005',{currency:'USD'}),'$0.01');
  assert.equal(render('2',{currency:'USD'}),'$2.00');
});

test('Tax is omitted from the service table without changing report totals or chart data', () => {
  const report = {...data, service_costs:[{service:'Tax',amount:'3',currency:'USD'},{service:'tax',amount:'2',currency:'USD'},{service:'S3',amount:'4',currency:'USD'}]};
  assert.deepEqual(serviceTable(report).rows.map(r=>r.service),['S3']);
  assert.deepEqual(report.totals,data.totals);
  assert.deepEqual(report.daily,data.daily);
});

test('reconciliation summary calculates subtotal, taxes and total for single and multiple currencies', () => {
  const report = {
    totals: [{ amount: '429.35', currency: 'USD' }],
    taxes: [{ amount: '39.03', currency: 'USD' }],
    service_costs: [
      { service: 'SageMaker', amount: '179.91', currency: 'USD' },
      { service: 'EC2', amount: '174.97', currency: 'USD' },
      { service: 'S3', amount: '17.87', currency: 'USD' },
      { service: 'Other', amount: '17.57', currency: 'USD' },
      { service: 'Tax', amount: '39.03', currency: 'USD' },
    ],
  };
  const html = reconciliationSummary(report);
  assert.match(html, /class="reconciliation-currency" data-currency="USD"/);
  assert.match(html, /<span class="reconciliation-label">Services<\/span><span class="reconciliation-value">\$390\.32<\/span>/);
  assert.match(html, /<span class="reconciliation-label">Taxes &amp; adjustments<\/span><span class="reconciliation-value">\$39\.03<\/span>/);
  assert.match(html, /<span class="reconciliation-label">Total<\/span><span class="reconciliation-value">\$429\.35<\/span>/);

  // When tax is zero
  const zeroTax = {
    totals: [{ amount: '100.00', currency: 'USD' }],
    taxes: [{ amount: '0', currency: 'USD' }],
    service_costs: [{ service: 'EC2', amount: '100.00', currency: 'USD' }],
  };
  const zeroHtml = reconciliationSummary(zeroTax);
  assert.match(zeroHtml, /<span class="reconciliation-label">Taxes &amp; adjustments<\/span><span class="reconciliation-value">\$0\.00<\/span>/);
  assert.match(zeroHtml, /<span class="reconciliation-label">Services<\/span><span class="reconciliation-value">\$100\.00<\/span>/);

  // When empty
  assert.equal(reconciliationSummary({ totals: [], service_costs: [] }), '');
});

test('renderReport includes reconciliation footer inside table card matching Total card', () => {
  const report = {
    ...data,
    totals: [{ amount: '25.00', currency: 'USD' }],
    taxes: [{ amount: '1.00', currency: 'USD' }],
    service_costs: [
      { service: 'EC2', amount: '24.00', currency: 'USD' },
      { service: 'Tax', amount: '1.00', currency: 'USD' },
    ],
  };
  const html = renderReport(report);
  assert.match(html, /<div class="table-card"><app-table data-report="services" aria-label="Service costs"><\/app-table><div class="table-reconciliation-footer"/);
  assert.match(html, /aria-label="Service costs reconciliation"/);
  assert.match(html, /Services<\/span><span class="reconciliation-value">\$24\.00<\/span>/);
  assert.match(html, /Taxes &amp; adjustments<\/span><span class="reconciliation-value">\$1\.00<\/span>/);
  assert.match(html, /Total<\/span><span class="reconciliation-value">\$25\.00<\/span>/);
});

test('serviceDisplayName clarifies EC2 - Other as storage and add-ons while preserving other service names', () => {
  assert.equal(serviceDisplayName('EC2 - Other'), 'EC2 - Storage & Add-ons (EBS, IPs)');
  assert.equal(serviceDisplayName('  EC2 - Other  '), 'EC2 - Storage & Add-ons (EBS, IPs)');
  assert.equal(serviceDisplayName('Amazon SageMaker'), 'Amazon SageMaker');
  assert.equal(serviceDisplayName('Amazon Elastic Compute Cloud - Compute'), 'Amazon Elastic Compute Cloud - Compute');
  assert.equal(serviceDisplayName(''), '');

  const model = serviceTable({
    service_costs: [
      { service: 'EC2 - Other', amount: '19.88', currency: 'USD' },
      { service: 'Amazon SageMaker', amount: '154.38', currency: 'USD' },
    ],
  });
  const renderService = model.columns[0].render;
  const sortService = model.columns[0].sortValue;
  assert.equal(renderService('EC2 - Other'), 'EC2 - Storage &amp; Add-ons (EBS, IPs)');
  assert.equal(sortService('EC2 - Other'), 'EC2 - Storage & Add-ons (EBS, IPs)');
  assert.equal(renderService('Amazon SageMaker'), 'Amazon SageMaker');
});

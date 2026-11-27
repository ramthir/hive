import { dailyPanel, money as currencyMoney } from './openai-format.js';
import { renderStatCard } from '../components/stat-card-render.js';
import { escapeHtml as escape } from "../html.js";
export const reportUrl = (month, service = '') => `/api/limark/aws?${new URLSearchParams({ month, view: 'dashboard', ...(service ? { service } : {}) })}`;
export const money = (amount, currency) => `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escape(currency)}`;
const chartCategories = [
  { key: 'EC2 & related', label: 'EC2 & related', className: 'aws-ec2' },
  { key: 'S3', label: 'S3', className: 'aws-s3' },
  { key: 'SageMaker', label: 'SageMaker', className: 'aws-sagemaker' },
  { key: 'Tax', label: 'Tax', className: 'aws-tax' },
  { key: 'Other', label: 'Other', className: 'aws-other' },
];
const categoryDetails = {
  'EC2 & related': { icon: 'fa-solid fa-microchip', description: 'Compute, storage & add-ons, VPC and load balancing' },
  SageMaker: { icon: 'fa-solid fa-brain', description: 'SageMaker services' },
  S3: { icon: 'fa-solid fa-folder', description: 'Simple Storage Service' },
  Total: { icon: 'fa-solid fa-coins', description: 'All services, including taxes and credits' },
};
export function renderReport(data) {

  const notice = data.message ? `<p class="notice" role="status">${escape(data.message)}</p>` : '';
  if (!data.account_id) return `${notice}<p>Awaiting the first AWS collection.</p>`;
  const charts = dailyPanel(data, { categories: chartCategories });
  const cards = [
    ...(data.category_costs || []).filter(t => !['Other', 'Tax'].includes(t.category)),
    ...data.totals.map(t => ({ ...t, category: 'Total' })),
  ].sort((a, b) => a.currency.localeCompare(b.currency) || ['EC2 & related', 'SageMaker', 'S3', 'Total'].indexOf(a.category) - ['EC2 & related', 'SageMaker', 'S3', 'Total'].indexOf(b.category));
  const reconciliation = reconciliationSummary(data);
  const footer = reconciliation ? `<div class="table-reconciliation-footer" aria-label="Service costs reconciliation">${reconciliation}</div>` : '';
  return `${notice}<div class="stat-card-grid metric-grid">${cards.map(t => {
      const details = categoryDetails[t.category] || categoryDetails.Total;
      return renderStatCard({
        title: t.category,
        icon: details.icon,
        value: `${Number(t.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t.currency}`,
        sub: details.description,
      });
    }).join('')}</div>
    ${charts}<section class="report-panel" aria-label="Service costs"><div class="table-card"><app-table data-report="services" aria-label="Service costs"></app-table>${footer}</div></section>
    `;
}

export function reconciliationSummary(data) {
  const currencies = [...new Set([
    ...(data.totals || []).map(t => t.currency),
    ...(data.taxes || []).map(t => t.currency),
    ...(data.service_costs || []).map(r => r.currency),
  ])].sort();
  if (!currencies.length) return '';
  const rows = serviceTable(data).rows;
  return currencies.map(currency => {
    const serviceRows = rows.filter(r => r.currency === currency);
    const servicesTotal = serviceRows.reduce((sum, r) => sum + Number(r.amount), 0);
    const totalEntry = (data.totals || []).find(t => t.currency === currency);
    const totalAmount = totalEntry ? Number(totalEntry.amount) : servicesTotal;
    const taxEntry = (data.taxes || []).find(t => t.currency === currency);
    const taxAmount = taxEntry !== undefined ? Number(taxEntry.amount) : totalAmount - servicesTotal;
    return `<div class="reconciliation-currency" data-currency="${escape(currency)}">` +
      `<div class="reconciliation-items">` +
      `<span class="reconciliation-item"><span class="reconciliation-label">Services</span><span class="reconciliation-value">${escape(currencyMoney(servicesTotal, currency, 2))}</span></span>` +
      `<span class="reconciliation-divider" aria-hidden="true">+</span>` +
      `<span class="reconciliation-item"><span class="reconciliation-label">Taxes &amp; adjustments</span><span class="reconciliation-value">${escape(currencyMoney(taxAmount, currency, 2))}</span></span>` +
      `<span class="reconciliation-divider" aria-hidden="true">=</span>` +
      `<span class="reconciliation-item reconciliation-total"><span class="reconciliation-label">Total</span><span class="reconciliation-value">${escape(currencyMoney(totalAmount, currency, 2))}</span></span>` +
      `</div></div>`;
  }).join('');
}


export function serviceDisplayName(service) {
  const normalized = String(service ?? '').trim();
  if (normalized === 'EC2 - Other') {
    return 'EC2 - Storage & Add-ons (EBS, IPs)';
  }
  return service;
}

export function serviceTable(data) {
  return {
    columns: [
      {
        key: 'service',
        label: 'Service',
        sortable: true,
        sortValue: value => serviceDisplayName(value),
        render: value => escape(serviceDisplayName(value)),
      },
      { key: 'amount', label: 'Cost', sortable: true, className: 'num',
        sortValue: value => Number(value), render: (value, row) => escape(currencyMoney(value, row.currency, 2)) },
    ],
    rows: (data.service_costs || []).filter(row => row.service.trim().toLowerCase() !== 'tax' && Math.abs(Number(row.amount)) >= 0.005),
  };
}

export function fillTables(root, data) {
  const table = root.querySelector('app-table[data-report="services"]');
  if (!table) return;
  const model = serviceTable(data);
  table.setColumns(model.columns);
  table.setEmptyState({ icon: 'fa-table-list', title: 'No service costs for this selection.' });
  table.setData(model.rows);
}

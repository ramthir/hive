import '../components/combobox.js';
import '../components/stat-card.js';
import '../components/table.js';
import '../components/tooltip.js';
import * as aws from './aws-format.js';
import * as openai from './openai-format.js';

class LimarkUsage extends HTMLElement {
  connectedCallback() {
    const { pathname } = location;
    const isOpenAI = pathname === '/limark/openai';
    const heading = pathname === '/limark' ? 'Limark' : isOpenAI ? 'OpenAI API Usage' : 'Amazon Web Services';
    this.report = isOpenAI ? openai : aws;
    this.innerHTML = `<section class="limark-page">
      <app-header heading="${heading}">
        <div slot="actions" class="limark-header-actions">
          <app-combobox required aria-label="Month (UTC)"></app-combobox>
        </div>
      </app-header>
      <p class="freshness" role="status"></p>
      <div class="report-content"></div>
    </section>`;
    this.month = this.querySelector('app-combobox');
    const requested = new URLSearchParams(location.search).get('month') || '';
    const current = new Date().toISOString().slice(0, 7);
    const selected = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : current;
    this.month.optionsList = openai.monthOptions(current, selected);
    this.month.value = selected;
    this.month.addEventListener('change', () => this.load());
    this.load();
  }

  disconnectedCallback() {
    this.controller?.abort();
  }

  async load() {
    const month = this.month.value;
    if (!month) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const content = this.querySelector('.report-content');
    const status = this.querySelector('.freshness');
    content.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading report…';
    try {
      const response = await fetch(this.report.reportUrl(month), { signal: controller.signal });
      if (!response.ok) throw new Error('The report could not be loaded.');
      const data = await response.json();
      if (controller.signal.aborted) return;
      content.innerHTML = this.report.renderReport(data);
      this.report.fillTables(content, data);
      this.loadedMonth = month;
      status.textContent = '';
      history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ month })}`);
    } catch {
      if (!controller.signal.aborted) {
        status.textContent = this.loadedMonth
          ? `Could not load ${month}. Showing ${this.loadedMonth}.`
          : 'The report could not be loaded.';
      }
    } finally {
      if (this.controller === controller) content.removeAttribute('aria-busy');
    }
  }
}

customElements.define('limark-usage', LimarkUsage);

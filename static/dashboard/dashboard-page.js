import '/static/components/tab-bar.js';
import '/static/dashboard/debian-tab.js';
import '/static/agents/agents-tab.js';
import '/static/colab/colab-tab.js';
import { TABS, tabBarTabs, tabForPath } from '/static/dashboard/tabs.js';

/**
 * The dashboard: a tab bar over one tab at a time. Only the shown tab is in the page, so a hidden tab does no polling.
 * Switching changes the address without a reload (back and forward move between tabs).
 */
class DashboardApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <section class="dash-page">
        <app-header heading="Dashboard" variant="flush" attached>
          <div slot="actions" class="app-header-action-group">
            <span class="dash-status" role="status" aria-live="polite"></span>
            <app-tab-bar></app-tab-bar>
          </div>
        </app-header>
        <div class="dash-tab"></div>
      </section>`;
    this.status = this.querySelector('.dash-status');
    this.holder = this.querySelector('.dash-tab');
    this.bar = this.querySelector('app-tab-bar');
    this.bar.tabs = tabBarTabs();
    this.bar.addEventListener('tab-switch', ({ detail }) => this.go(detail.tab));
    this.addEventListener('tab-status', ({ detail }) => this.setStatus(detail.text, detail.error));
    window.addEventListener('popstate', this.onPop = () => this.show(tabForPath(location.pathname)));
    this.show(tabForPath(location.pathname));
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this.onPop);
  }

  go(tab) {
    if (location.pathname !== TABS[tab].path) history.pushState({ tab }, '', TABS[tab].path);
    this.show(tab);
  }

  show(tab) {
    this.tab = tab;
    this.bar.active = tab;
    this.setStatus('');
    document.title = `${TABS[tab].label} - Dashboard - Hive`;
    this.holder.replaceChildren(document.createElement(TABS[tab].element));
  }

  setStatus(text, isError = false) {
    this.status.textContent = text;
    this.status.title = text || '';
    this.status.classList.toggle('error', Boolean(isError));
  }
}

customElements.define('dashboard-app', DashboardApp);

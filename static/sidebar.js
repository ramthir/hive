/**
 * App Sidebar Web Component (light DOM, styled by sidebar.css like Pandora's).
 * A left sidebar that can be collapsed (Ctrl/Cmd+\ or B). Hive is a desktop app: there is no mobile layout.
 *
 * Hive's version is deliberately small: five navigation items (the container Dashboard, the Tasks board, Notes, Time entries and Chat), and a hardcoded user at the bottom
 * (there is no sign-in yet).
 */

// The signed-in user, hardcoded until Hive has authentication.
const CURRENT_USER = Object.freeze({ name: 'Ramesh Thiruchelvam' });

const NAVIGATION_ITEMS = Object.freeze([
  { href: '/dashboard', label: 'Dashboard', icon: 'fa-solid fa-gauge-high', activePaths: ['/dashboard'] },
  { href: '/tasks', label: 'Tasks', icon: 'fa-solid fa-list-check', activePaths: ['/tasks'] },
  { href: '/notes', label: 'Notes', icon: 'fa-solid fa-book-open', activePaths: ['/notes'] },
  { href: '/time-entries', label: 'Time Entries', icon: 'fa-solid fa-clock', activePaths: ['/time-entries'] },
  { href: '/chat', label: 'Chat', icon: 'fa-solid fa-comments', activePaths: ['/chat'] },
]);

const COLLAPSED_KEY = 'hive:sidebar-collapsed';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const initialsOf = (name = '') =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'U';

const isEditable = (event) => {
  const path = event.composedPath ? event.composedPath() : [event.target];
  return path.some((target) => target instanceof Element
    && (target.matches('input, textarea, select, [contenteditable="true"]')
      || Boolean(target.closest?.('input, textarea, select, [contenteditable="true"], .cm-content, .cm-editor'))));
};

class AppSidebar extends HTMLElement {
  static get observedAttributes() {
    return ['active-href'];
  }

  constructor() {
    super();
    this._shortcutHandler = null;
  }

  attributeChangedCallback() {
    if (this.isConnected && this.querySelector('.nav-link')) this.updateActiveState();
  }

  connectedCallback() {
    this.render();
    this.restoreVisibilityPreference();
    this._shortcutHandler = (event) => this.handleSidebarShortcut(event);
    document.addEventListener('keydown', this._shortcutHandler);
  }

  disconnectedCallback() {
    if (this._shortcutHandler) document.removeEventListener('keydown', this._shortcutHandler);
    this._shortcutHandler = null;
  }

  /* --- visibility ------------------------------------------------------ */

  restoreVisibilityPreference() {
    try {
      if (localStorage.getItem(COLLAPSED_KEY) === 'true') this.setSidebarVisible(false, false);
    } catch (_) { /* storage unavailable: stay expanded */ }
  }

  isSidebarVisible() {
    return !this.classList.contains('sidebar-collapsed');
  }

  setSidebarVisible(visible, persist = true) {
    if (persist) {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!visible));
      } catch (_) { /* ignore */ }
    }
    // The page content (and fixed bars) move over by the sidebar's width; a collapsed sidebar gives it back.
    const shell = this.getRootNode()?.host;
    if (shell?.localName === 'app-shell') {
      if (visible) shell.style.removeProperty('--sidebar-content-offset');
      else shell.style.setProperty('--sidebar-content-offset', '0px');
    }
    const collapseBtn = this.querySelector('.desktop-collapse-btn');
    const expandBtn = this.querySelector('.sidebar-expand-btn');
    collapseBtn?.setAttribute('aria-expanded', String(visible));
    expandBtn?.setAttribute('aria-expanded', String(visible));

    this.classList.toggle('sidebar-collapsed', !visible);
    const focusTarget = visible ? collapseBtn : expandBtn;
    if (focusTarget && document.activeElement && this.contains(document.activeElement)) {
      requestAnimationFrame(() => focusTarget.focus());
    }
  }

  // Ctrl/Cmd + \ or B toggles the sidebar (not while typing, where B is bold-ish and the editor owns its keys).
  handleSidebarShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || isEditable(event)) return;
    if (event.key === '\\' || event.code === 'Backslash' || event.key.toLowerCase() === 'b' || event.code === 'KeyB') {
      event.preventDefault();
      this.setSidebarVisible(!this.isSidebarVisible());
    }
  }

  /* --- navigation ------------------------------------------------------ */

  updateActiveState() {
    const path = window.location.pathname;
    const declared = this.getAttribute('active-href');
    this.querySelectorAll('.nav-link').forEach((link) => {
      const href = link.getAttribute('href');
      const item = NAVIGATION_ITEMS.find((candidate) => candidate.href === href);
      const byPath = Boolean(item?.activePaths.some((p) => path === p || path.startsWith(`${p}/`)));
      const active = declared ? declared === href : byPath;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  render() {
    const stylesheet = `${new URL('./sidebar.css', import.meta.url).href}?v=1`;
    this.innerHTML = `
      <link rel="stylesheet" href="/static/vendor/fontawesome/css/all.min.css">
      <link rel="stylesheet" href="${stylesheet}">
      <button class="sidebar-expand-btn" type="button" aria-label="Expand sidebar" aria-expanded="false" aria-controls="sidebar-nav" title="Expand sidebar (Ctrl+\\)">
        <i class="fa-solid fa-angles-right" aria-hidden="true"></i>
      </button>
      <nav class="app-sidebar" aria-label="Main Navigation">
        <div class="sidebar-header">
          <a href="/notes" class="logo" aria-label="Note Hive Home">
            <i class="fa-solid fa-circle-nodes" aria-hidden="true"></i>
            <span class="logo-text">Note Hive</span>
          </a>
          <button class="desktop-collapse-btn" type="button" aria-label="Collapse sidebar" aria-expanded="true" aria-controls="sidebar-nav" title="Collapse sidebar (Ctrl+\\)">
            <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
          </button>
        </div>
        <div class="sidebar-nav" id="sidebar-nav">
          ${NAVIGATION_ITEMS.map((item) => `
            <a href="${escapeHtml(item.href)}" class="nav-link" title="${escapeHtml(item.label)}">
              <i class="${escapeHtml(item.icon)}" aria-hidden="true"></i>
              <span>${escapeHtml(item.label)}</span>
            </a>`).join('')}
        </div>
        <div class="sidebar-profile" aria-label="Logged in user">
          <span class="sidebar-profile-avatar" aria-hidden="true">${escapeHtml(initialsOf(CURRENT_USER.name))}</span>
          <span class="sidebar-profile-details">
            <span class="sidebar-profile-name">${escapeHtml(CURRENT_USER.name)}</span>
          </span>
        </div>
      </nav>`;

    this.querySelector('.desktop-collapse-btn')?.addEventListener('click', () => this.setSidebarVisible(false));
    this.querySelector('.sidebar-expand-btn')?.addEventListener('click', () => this.setSidebarVisible(true));

    // The shell hides its content until the sidebar's own stylesheets have loaded, then fades it in.
    const sheets = [...this.querySelectorAll('link[rel="stylesheet"]')];
    Promise.all(sheets.map((link) => new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
    }))).then(() => this.dispatchEvent(new CustomEvent('ready', { bubbles: true })));

    this.updateActiveState();
  }
}

if (!customElements.get('app-sidebar')) customElements.define('app-sidebar', AppSidebar);

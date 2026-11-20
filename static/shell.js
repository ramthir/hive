import './sidebar.js';
import './app-header.js';
import './components/tooltip.js';
import './components/note-spotlight.js';
import './toast.js';

/**
 * App Shell Web Component
 * A layout wrapper that provides consistent page structure
 *
 * Usage:
 *   <app-shell>
 *       <app-header heading="Dashboard">
 *           <button slot="actions">Action</button>
 *       </app-header>
 *       <!-- main content -->
 *       <div slot="footer">Footer content</div>
 *   </app-shell>
 */
class AppShell extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['active-href'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.syncActiveHref();
  }

  // Pages declare their nav tab with <app-shell active-href="/path">; mirror it to the sidebar.
  syncActiveHref() {
    const sidebar = this.shadowRoot.querySelector('app-sidebar');
    if (!sidebar) return;
    const href = this.getAttribute('active-href');
    if (href) sidebar.setAttribute('active-href', href);
    else sidebar.removeAttribute('active-href');
  }

  render() {
    this.shadowRoot.innerHTML = `
            <style>
                :host, :host *, :host *::before, :host *::after {
                    box-sizing: border-box;
                }

                :host {
                    display: block;
                    height: 100%;
                }

                /* app-sidebar lives in this shadow root, so the outer
                   document's own "app-sidebar:not(:defined)" FOUC rule
                   (if any) can't reach it — cover it here instead. */
                app-sidebar:not(:defined) {
                    visibility: hidden;
                }

                .shell {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }

                /* min-width values below must match --breakpoint-sm /
                   --breakpoint-lg in tokens.css — @media conditions can't
                   reference custom properties. */
                @media (min-width: 1024px) {
                    .shell {
                        flex-direction: row;
                    }
                }

                .page {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-width: 0;
                    min-height: 0;
                }

                .page-main {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                }

                .page-container {
                    --page-block-padding: var(--space-5, 1.25rem);
                    --page-inline-padding: var(--space-4, 1rem);
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                    gap: var(--space-6, 1.5rem);
                    max-width: var(--content-max-width, 80rem);
                    width: 100%;
                    margin: 0 auto;
                    padding: var(--page-block-padding) var(--page-inline-padding);
                }

                :host([full-width]) .page-container {
                    max-width: none;
                    margin: 0;
                }

                @media (min-width: 640px) {
                    .page-container {
                        --page-block-padding: var(--space-6, 1.5rem);
                        --page-inline-padding: var(--space-6, 1.5rem);
                    }
                }

                @media (min-width: 1024px) {
                    .page-container {
                        --page-inline-padding: var(--space-7, 2rem);
                    }
                }

                /* fill: occupy exactly the viewport and let the slotted app
                   (e.g. chat) manage its own scrolling. */
                :host([fill]) {
                    height: 100vh;
                    overflow: hidden;
                }

                :host([fill]) .shell {
                    height: 100vh;
                    background: var(--color-background);
                }

                :host([fill]) .page-container {
                    --page-block-padding: var(--space-5, 1.25rem);
                    --page-inline-padding: var(--space-6, 1.5rem);
                    flex: 1;
                    min-height: 0;
                    gap: 0;
                }

                @media (min-width: 1024px) {
                    :host([fill]) .page-container {
                        --page-inline-padding: var(--space-7, 2rem);
                    }
                }

            </style>

            <div class="shell">
                <app-sidebar></app-sidebar>
                <div class="page">
                    <main class="page-main">
                        <div class="page-container">
                            <slot></slot>
                        </div>
                    </main>
                </div>
            </div>
        `;

    this.syncActiveHref();

    // Flip a "ready" class on the host element once app-sidebar's own
    // stylesheets have actually loaded (not just once it's defined).
    // Consumers style against app-shell/app-shell.ready with a plain
    // opacity fade — they never need to reference sidebar.css directly.
    this.shadowRoot
      .querySelector('app-sidebar')
      .addEventListener('ready', () => this.classList.add('ready'), { once: true });
  }
}

customElements.define('app-shell', AppShell);

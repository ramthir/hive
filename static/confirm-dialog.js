/**
 * Confirm Dialog Component - CRM-style, Pandora-simplified
 * A reusable confirmation dialog matching Pandora design tokens.
 *
 * Usage:
 *   const confirmed = await confirmDialog({
 *     title: 'Delete Profile?',
 *     message: 'This action cannot be undone.',
 *     okText: 'Delete',
 *     cancelText: 'Cancel'
 *   });
 */

function confirmDialog(options = {}) {
  return new Promise((resolve) => {
    const {
      title = 'Confirm Action',
      message = 'Are you sure?',
      okText = 'Confirm',
      cancelText = 'Cancel',
      iconClass = null,
    } = options;

    // Auto-detect warning icon for delete/remove actions
    let icon = iconClass;
    let isDeleteAction = false;
    if (!icon) {
      const lowerOkText = okText.toLowerCase();
      if (lowerOkText.includes('delete') || lowerOkText.includes('remove')) {
        icon = 'fa-triangle-exclamation';
        isDeleteAction = true;
      } else {
        icon = 'fa-circle-info';
      }
    } else if (iconClass && iconClass.includes('exclamation')) {
      isDeleteAction = true;
    }

    // Remove existing dialog if any
    const existing = document.getElementById('confirm-dialog');
    if (existing) existing.remove();

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'confirm-dialog';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 10000;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(var(--dialog-overlay-blur, 4px));
      -webkit-backdrop-filter: blur(var(--dialog-overlay-blur, 4px));
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    // Create card
    const card = document.createElement('div');
    card.style.cssText = `
      display: flex;
      flex-direction: column;
      position: relative;
      background: var(--color-dark1);
      border: 1px solid var(--color-dimmed5);
      border-radius: var(--radius-xl, 20px);
      max-width: 560px;
      width: 90%;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    `;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.style.cssText = `
      position: absolute;
      top: 1rem;
      right: 1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border: none;
      border-radius: 6px;
      color: var(--color-dimmed3);
      background: transparent;
      cursor: pointer;
      transition: all 0.15s;
    `;

    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'var(--color-dark2)';
      closeBtn.style.color = 'var(--color-text)';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'transparent';
      closeBtn.style.color = 'var(--color-dimmed3)';
    });

    // Body
    const body = document.createElement('div');
    body.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1.5rem 1.5rem 0 1.5rem;
    `;

    // Header (icon + title + message)
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 1rem;
    `;

    // Use accent1 (red/warning) for delete actions, accent5 (cyan) for others
    const iconColor = isDeleteAction ? 'var(--color-accent1)' : 'var(--color-accent5)';
    const iconBg = 'var(--color-dark2)';

    const iconEl = document.createElement('div');
    iconEl.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    iconEl.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 3rem;
      height: 3rem;
      flex-shrink: 0;
      border-radius: 50%;
      background: ${iconBg};
      color: ${iconColor};
      font-size: 1.3rem;
    `;

    const textSection = document.createElement('div');
    textSection.style.flex = '1';

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    titleEl.style.cssText = `
      margin: 0;
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--color-text);
    `;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;
    messageEl.style.cssText = `
      margin: 0.5rem 0 0 0;
      font-size: 0.875rem;
      color: var(--color-dimmed2);
      line-height: 1.5;
    `;

    textSection.appendChild(titleEl);
    textSection.appendChild(messageEl);
    header.appendChild(iconEl);
    header.appendChild(textSection);
    body.appendChild(header);

    // Actions footer
    const actions = document.createElement('div');
    actions.style.cssText = `
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = cancelText;
    cancelBtn.style.cssText = `
      background: transparent;
      border: 1px solid var(--color-dimmed5);
      color: var(--color-dimmed2);
      font-family: var(--font-family);
      font-size: 0.85rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    `;

    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'var(--color-dark1)';
      cancelBtn.style.borderColor = 'var(--color-dimmed4)';
      cancelBtn.style.color = 'var(--color-text)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.borderColor = 'var(--color-dimmed5)';
      cancelBtn.style.color = 'var(--color-dimmed2)';
    });

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = okText;
    okBtn.style.cssText = `
      background: var(--color-accent5);
      border: none;
      color: #0d1117;
      font-family: var(--font-family);
      font-size: 0.85rem;
      font-weight: 700;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    `;

    okBtn.addEventListener('mouseenter', () => {
      okBtn.style.background = 'var(--color-accent5-bright, #90e8f0)';
      okBtn.style.opacity = '0.95';
    });
    okBtn.addEventListener('mouseleave', () => {
      okBtn.style.background = 'var(--color-accent5)';
      okBtn.style.opacity = '1';
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    // Assemble
    card.appendChild(closeBtn);
    card.appendChild(body);
    card.appendChild(actions);
    overlay.appendChild(card);

    // Event handlers
    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    okBtn.addEventListener('click', () => cleanup(true));
    closeBtn.addEventListener('click', () => cleanup(false));

    // Close on Escape
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escapeHandler);
        cleanup(false);
      }
    };
    document.addEventListener('keydown', escapeHandler);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup(false);
      }
    });

    // Mount
    document.body.appendChild(overlay);

    // Focus OK button
    okBtn.focus();
  });
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = confirmDialog;
}

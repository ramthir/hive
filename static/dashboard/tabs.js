/** The dashboard's tabs. Each has its own address, so a reload or a link opens the same tab. */
export const TABS = Object.freeze({
  debian: { label: 'Debian', icon: 'fa-brands fa-debian', path: '/dashboard', element: 'debian-tab', heading: 'Container' },
  agents: { label: 'Agents', icon: 'fa-solid fa-robot', path: '/dashboard/agents', element: 'agents-tab', heading: 'Agents' },
  colab: { label: 'Colab', icon: 'fa-solid fa-cloud', path: '/dashboard/colab', element: 'colab-tab', heading: 'Colab' },
});

/** The tab an address opens; anything that is not a tab's own path opens Debian. */
export function tabForPath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  return Object.keys(TABS).find((key) => TABS[key].path === path) || 'debian';
}

/** The tab bar's `tabs` property. */
export const tabBarTabs = () => Object.fromEntries(Object.entries(TABS).map(([key, { label, icon }]) => [key, { label, icon }]));

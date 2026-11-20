function normalizePath(pathname) {
  if (!pathname) return '/';
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

function routeSegments(path) {
  return normalizePath(path).split('/').filter(Boolean);
}

function compareSpecificity(left, right) {
  const count = Math.min(left.segments.length, right.segments.length);
  for (let index = 0; index < count; index += 1) {
    const leftParameter = left.segments[index].startsWith(':');
    const rightParameter = right.segments[index].startsWith(':');
    if (leftParameter !== rightParameter) return leftParameter ? 1 : -1;
  }
  return right.segments.length - left.segments.length;
}

export function compileRoutes(entries) {
  return Array.from(entries)
    .filter(([path]) => path !== '*')
    .map(([path, config]) => ({
      path: normalizePath(path),
      segments: routeSegments(path),
      config,
    }))
    .sort(compareSpecificity);
}

export function matchRoute(routes, pathname) {
  const segments = routeSegments(pathname);

  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;

    const params = {};
    const matched = route.segments.every((segment, index) => {
      if (!segment.startsWith(':')) return segment === segments[index];
      try {
        params[segment.slice(1)] = decodeURIComponent(segments[index]);
        return true;
      } catch {
        return false;
      }
    });
    if (matched) return { config: route.config, params, path: route.path };
  }

  return null;
}

export class ScopedRouter {
  constructor({ basename = '/', windowObject = window, documentObject = windowObject.document } = {}) {
    this.basename = normalizePath(basename);
    this.window = windowObject;
    this.document = documentObject;
    this._entries = new Map();
    this._compiledRoutes = [];
    this._listeners = new Set();
    this._cleanups = new Set();
    this._generation = 0;
    this._started = false;
    this._handlePopState = () => this._notify();
    this._handleClick = (event) => {
      if (
        event.defaultPrevented ||
        event.button > 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target?.closest?.('a[data-route]');
      if (!link || link.target || link.hasAttribute('download')) return;

      const href = link.getAttribute('href');
      if (!href) return;
      const destination = new URL(href, this.window.location.href);
      if (destination.origin !== this.window.location.origin || !this.getMatch(destination.pathname)) return;

      event.preventDefault();
      this.navigate(destination.href);
    };
    this.start();
  }

  register(path, config) {
    this._entries.set(normalizePath(path), config);
    this._compiledRoutes = compileRoutes(this._entries.entries());
    return this;
  }

  registerFallback(config) {
    this._entries.set('*', config);
    return this;
  }

  getMatch(path = this.currentPath) {
    return matchRoute(this._compiledRoutes, path);
  }

  getRoute(path = this.currentPath) {
    return this.getMatch(path)?.config ?? this._entries.get('*');
  }

  get currentPath() {
    return normalizePath(this.window.location.pathname);
  }

  navigate(destination, { replace = false, state = {} } = {}) {
    const next = new URL(destination, this.window.location.href);
    const match = this.getMatch(next.pathname);
    const destinationInsideScope =
      this.basename === '/'
        ? Boolean(match)
        : next.pathname === this.basename || next.pathname.startsWith(`${this.basename}/`);
    const currentInsideScope =
      this.basename === '/'
        ? Boolean(this.getMatch(this.currentPath))
        : this.currentPath === this.basename || this.currentPath.startsWith(`${this.basename}/`);

    if (next.origin !== this.window.location.origin || !currentInsideScope || !destinationInsideScope) {
      this.window.location.assign(next.href);
      return;
    }

    const nextUrl = `${next.pathname}${next.search}${next.hash}`;
    const currentUrl = `${this.window.location.pathname}${this.window.location.search}${this.window.location.hash}`;
    if (nextUrl === currentUrl) return;

    const method = replace ? 'replaceState' : 'pushState';
    this.window.history[method](state, '', nextUrl);
    this._notify();
  }

  subscribe(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  refresh() {
    this._notify();
  }

  start() {
    if (this._started) return;
    this.window.addEventListener('popstate', this._handlePopState);
    this.document?.addEventListener('click', this._handleClick);
    this._started = true;
  }

  stop() {
    if (!this._started) return;
    this.window.removeEventListener('popstate', this._handlePopState);
    this.document?.removeEventListener('click', this._handleClick);
    this._started = false;
    this._generation += 1;
    this._runCleanups();
  }

  _notify() {
    this._generation += 1;
    const generation = this._generation;
    this._runCleanups();
    const match = this.getMatch();
    const route = match?.config ?? this._entries.get('*');
    const context = {
      generation,
      state: this.window.history.state,
      isStale: () => generation !== this._generation,
      registerCleanup: (cleanup) => {
        if (typeof cleanup !== 'function') return;
        if (generation !== this._generation) {
          cleanup();
          return;
        }
        this._cleanups.add(cleanup);
      },
    };
    this._listeners.forEach((callback) => callback(this.currentPath, route, match?.params ?? {}, context));
  }

  _runCleanups() {
    const cleanups = this._cleanups;
    this._cleanups = new Set();
    cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.error('Route cleanup failed:', error);
      }
    });
  }
}

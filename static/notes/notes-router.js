import { ScopedRouter } from '/static/scoped-router.js';

export const notesRouter = new ScopedRouter({ basename: '/notes' });
notesRouter.register('/notes', { view: 'list' });
notesRouter.register('/notes/new', { view: 'editor', isNew: true });
notesRouter.register('/notes/:slug', { view: 'editor' });
notesRouter.registerFallback({ view: 'list' });

// Express app construction. Mounts routes + brotli-aware static
// serving and returns the app without listening; index.js binds the
// port, tests use supertest against buildApp().

import express from 'express';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { REPO_ROOT_PATH as REPO_ROOT } from './config.js';

import { brotliMiddleware } from './middleware/brotli.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { probesRouter } from './routes/probes.js';
import { oauthRouter } from './routes/oauth.js';
import { sessionRouter } from './routes/session.js';
import { notificationsRouter } from './routes/notifications.js';
import { slackCommandRouter } from './routes/slack-command.js';

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  // Populates req.cookies — read by util/session.js (no CSRF middleware:
  // sweeper.bitvox.me is its own origin, so SameSite=Lax + CORS isolate).
  app.use(cookieParser());
  app.use(vehiclesRouter);
  app.use(probesRouter);
  app.use(oauthRouter);
  app.use(sessionRouter);
  app.use(notificationsRouter);
  app.use(slackCommandRouter);
  // API 404 catch — must come BEFORE the SPA catch-all so unknown
  // /api/* paths return JSON instead of the index.html bundle.
  app.all('/api/*', (req, res) => res.status(404).json({ detail: 'API endpoint not found' }));
  app.use(brotliMiddleware(join(REPO_ROOT, 'dist')));
  app.use(express.static(join(REPO_ROOT, 'dist')));
  app.get('*', (req, res) => res.sendFile(join(REPO_ROOT, 'dist', 'index.html')));
  return app;
}

// Express app construction. Loads .env, mounts the json body parser +
// route modules + the .br-aware static serving, and returns the app
// without listening on a port. index.js calls listen() and the cron
// scheduler; tests can import { buildApp } and exercise routes via
// supertest without binding a port.

import express from 'express';
import { join } from 'path';
import { REPO_ROOT_PATH as REPO_ROOT } from './config.js';

import { brotliMiddleware } from './middleware/brotli.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { probesRouter } from './routes/probes.js';
import { oauthRouter } from './routes/oauth.js';
import { notificationsRouter } from './routes/notifications.js';

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(vehiclesRouter);
  app.use(probesRouter);
  app.use(oauthRouter);
  app.use(notificationsRouter);
  // API 404 catch — must come BEFORE the SPA catch-all so unknown
  // /api/* paths return JSON instead of the index.html bundle.
  app.all('/api/*', (req, res) => res.status(404).json({ detail: 'API endpoint not found' }));
  app.use(brotliMiddleware(join(REPO_ROOT, 'dist')));
  app.use(express.static(join(REPO_ROOT, 'dist')));
  app.get('*', (req, res) => res.sendFile(join(REPO_ROOT, 'dist', 'index.html')));
  return app;
}

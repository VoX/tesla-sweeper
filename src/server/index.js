// Tesla Sweeper service entry. Builds the express app, registers the
// notification cron, listens, and fires both missed-run recovery
// helpers in case the box was down across a scheduled fire time.

// MUST be the first import — config.js loads .env into process.env so
// transitively-imported integration modules (which read env at module
// eval time) see the values. Reordering this line breaks the boot.
import './config.js';
import { buildApp } from './app.js';
import {
  startNotificationCron, maybeRecoverMissedRun, maybeRecoverMissedDigest,
} from './notifications/cron.js';

// Exit on uncaught exceptions — continuing leaves the process in
// undefined state (mid-write file handles, half-rotated tokens).
// systemd will restart cleanly via Restart=on-failure.
process.on('uncaughtException', (e) => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const PORT = process.env.PORT || 20040;
buildApp().listen(PORT, '127.0.0.1', () => {
  console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`);
  startNotificationCron();
  maybeRecoverMissedRun();
  maybeRecoverMissedDigest();
});

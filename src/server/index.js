// Tesla Sweeper service entry. Builds app, starts cron, fires
// missed-run recovery helpers.

// MUST be first — config.js loads .env so integration modules (which
// read process.env at module-eval time) see values. Don't reorder.
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
buildApp().listen(PORT, '127.0.0.1', async () => {
  console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`);
  startNotificationCron();
  // Sequential — runNotifications is single-flight by mode and throws
  // on cross-mode overlap, so a Sunday-8PM-ish boot would otherwise
  // race the daily and weekly recoveries and one would silently fail.
  try { await maybeRecoverMissedRun(); }
  catch (e) { console.error('[cron] missed-run recovery failed:', e); }
  try { await maybeRecoverMissedDigest(); }
  catch (e) { console.error('[cron] missed-digest recovery failed:', e); }
});

// Subscription endpoints for daily sweep notifications + manual /run.
// HMAC session gate on /enable + /disable closes the confused-deputy
// hole (a Tesla refresh_token alone shouldn't let you subscribe an
// arbitrary slack_user_id).

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { wrap } from '../middleware/errors.js';
import { verifySession } from '../crypto/session.js';
import { bearerOk } from '../crypto/bearer.js';
import { loadSubs, saveSubs, publicSub } from '../store/subscriptions.js';
import {
  STUB_REFRESH_TOKEN, isStubVehicle,
  teslaTokenExchange,
} from '../integrations/tesla.js';
import { postSlackDM } from '../integrations/slack.js';
import { runNotifications } from '../notifications/cron.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

export const notificationsRouter = Router();

notificationsRouter.post('/api/notifications/enable', wrap(async (req, res) => {
  const { refresh_token, vehicle_id, vehicle_name, slack_user_id, session } = req.body;
  if (!refresh_token || !slack_user_id || !vehicle_id) {
    return res.status(400).json({ detail: 'refresh_token, slack_user_id, and vehicle_id are required' });
  }
  // Confused-deputy gate: the slack_user_id has to come paired with a
  // server-issued HMAC session that was minted on a verified Slack
  // OIDC callback for that same id. Otherwise anyone with a Tesla
  // refresh_token could subscribe arbitrary slack_user_ids.
  if (!verifySession(session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  if (!SLACK_USER_ID_RE.test(slack_user_id)) {
    return res.status(400).json({ detail: 'slack_user_id should look like U060NLFUM' });
  }
  // Stub bypass: skip Tesla refresh entirely. The cron path branches
  // on STUB_REFRESH_TOKEN to short-circuit too.
  let storedRefreshToken = STUB_REFRESH_TOKEN;
  if (!isStubVehicle(vehicle_id)) {
    // Validate the refresh_token by exchanging it once. Tesla rotates
    // on every exchange, so we MUST persist the rotated value before
    // doing anything else that could throw — the original is now dead.
    // (We previously also did a vehicles-lookup here to verify reach;
    // a network failure between rotation and persistence locked the
    // user out. The cron's stuck-sub DM (3 consecutive failures)
    // surfaces bad vehicle_ids well enough.)
    let rotated;
    try {
      rotated = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token });
    } catch (e) {
      return res.status(400).json({ detail: 'Refresh token invalid: ' + e.message });
    }
    storedRefreshToken = rotated.refresh_token || refresh_token;
  }
  const subs = loadSubs();
  // One subscription per (slack_user_id, vehicle_id) — re-enable replaces.
  // String-coerce vehicle_id since Tesla IDs may round-trip as
  // numbers in older entries while the SPA sends strings.
  const filtered = subs.filter(s => !(s.slack_user_id === slack_user_id && String(s.vehicle_id) === String(vehicle_id)));
  const sub = {
    id: randomBytes(8).toString('hex'),
    slack_user_id,
    vehicle_id: String(vehicle_id),
    vehicle_name: vehicle_name || 'Unknown',
    refresh_token: storedRefreshToken,
    created_at: new Date().toISOString(),
    last_check_at: null,
  };
  filtered.push(sub);
  saveSubs(filtered);
  // Best-effort confirmation DM. Failure here doesn't undo the sub —
  // the user just won't see the confirmation. Surface the error in
  // the response so the SPA can hint at it.
  const dm = await postSlackDM(
    slack_user_id,
    `:car: Tesla sweeper notifications enabled for *${sub.vehicle_name}*. I'll DM you 1, 2, and 3 days before each sweep at noon ET. Disable anytime at https://claw.bitvox.me/sweeper/.`
  );
  res.json({ enabled: true, id: sub.id, test_dm_ok: dm.ok, test_dm_error: dm.error || null });
}));

notificationsRouter.post('/api/notifications/disable', wrap(async (req, res) => {
  const { id, slack_user_id, session } = req.body;
  if (!id || !slack_user_id) return res.status(400).json({ detail: 'id and slack_user_id required' });
  if (!verifySession(session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  const subs = loadSubs();
  const before = subs.length;
  const filtered = subs.filter(s => !(s.id === id && s.slack_user_id === slack_user_id));
  if (filtered.length === before) return res.status(404).json({ detail: 'Subscription not found' });
  saveSubs(filtered);
  res.json({ disabled: true });
}));

notificationsRouter.get('/api/notifications/status', (req, res) => {
  const { slack_user_id } = req.query;
  if (!slack_user_id) return res.status(400).json({ detail: 'slack_user_id required' });
  res.json({ subscriptions: loadSubs().filter(s => s.slack_user_id === slack_user_id).map(publicSub) });
});

// Manual trigger / monitoring endpoint. Same logic the in-process
// noon-ET cron calls.
notificationsRouter.post('/api/notifications/run', wrap(async (req, res) => {
  if (!bearerOk(req.get('authorization') || '', NOTIFICATIONS_RUN_TOKEN)) {
    return res.status(401).json({ detail: 'Unauthorized' });
  }
  res.json(await runNotifications());
}));

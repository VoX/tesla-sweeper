// Subscription endpoints for daily sweep notifications + manual /run.
//
// /enable + /disable are HMAC-gated on the Slack session — that's the
// confused-deputy fix (a Tesla refresh_token alone shouldn't let you
// subscribe an arbitrary slack_user_id). The Slack HMAC is the ONLY gate
// on /disable: a user whose Tesla session has expired must still be able
// to stop the DMs (re-do Slack OIDC → /disable, no Tesla OAuth needed).
//
// /enable requires a session cookie (the SPA OAuthed via /api/session/create
// first); the server reuses the cookie-bound record's server-owned
// refresh_token. One subscription per slack_user_id, deliberately
// (multi-vehicle is a separate, out-of-scope feature). Phase 8 dropped
// the legacy body-path that took an explicit refresh_token.

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { verifySession } from '../crypto/session.js';
import { bearerOk } from '../crypto/bearer.js';
import {
  deleteUser, patchUser,
  loadUsers, loadUserById, loadUserBySession, loadSubscribedUsers, publicUser,
} from '../store/users.js';
import { readSessionCookie } from '../util/session.js';
import { STUB_REFRESH_TOKEN, isStubVehicle } from '../integrations/tesla.js';
import { postSlackDM } from '../integrations/slack.js';
import { runNotifications } from '../notifications/cron.js';

const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

export const notificationsRouter = Router();

// A subscription's fields, cleared. Telemetry (failure streak, DM-dedup
// dates, stuck-DM cooldown) is zeroed too — so re-`/enable`ing a record
// later doesn't inherit a stale `last_dm_date` (would suppress the first
// real DM) or an old failure streak.
const CLEARED_SUB = {
  slack_user_id: null, vehicle_id: null, vehicle_name: null,
  consecutive_failures: 0, last_dm_date: null, last_digest_date: null, last_dm_error_at: null,
};
// The fresh-sub telemetry reset, applied alongside the new slack/vehicle
// fields when re-using an existing record (e.g. the cookie-bound one).
const FRESH_SUB_TELEMETRY = {
  consecutive_failures: 0, last_dm_date: null, last_digest_date: null, last_dm_error_at: null,
};

// One subscription per slack_user_id. Clears the sub on every record for
// `slackUserId` except `keepId`; a record that ends up with neither a sub
// nor a session-cookie binding is deleted outright. (Handles e.g. a
// pre-BFF migrated record that /session/create couldn't match by
// tesla_account_id, leaving a stale duplicate sub behind.)
function clearOtherSubs(slackUserId, keepId) {
  for (const u of loadUsers()) {
    if (u.id === keepId || u.slack_user_id !== slackUserId) continue;
    if (u.session_cookie_id) {
      patchUser(u.id, CLEARED_SUB);
      console.log(`[notifications] cleared duplicate sub on record ${u.id.slice(0, 8)} for ${slackUserId} (record kept — browser still bound)`);
    } else {
      deleteUser(u.id);
      console.log(`[notifications] deleted empty duplicate record ${u.id.slice(0, 8)} for ${slackUserId}`);
    }
  }
}

notificationsRouter.post('/api/notifications/enable', wrap(async (req, res) => {
  const { vehicle_id, vehicle_name, slack_user_id, slack_session } = req.body || {};
  if (!vehicle_id || !slack_user_id) return res.status(400).json({ detail: 'vehicle_id and slack_user_id are required' });
  // Confused-deputy gate: slack_user_id must arrive paired with a
  // server-issued HMAC session minted on a verified Slack OIDC callback
  // for that id.
  if (!verifySession(slack_session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  if (!SLACK_USER_ID_RE.test(slack_user_id)) return res.status(400).json({ detail: 'slack_user_id should look like U060NLFUM' });

  // Need a session cookie — the cookie-bound user record holds the
  // canonical refresh_token (set by /api/session/create on Tesla OAuth).
  const cookieUser = loadUserBySession(readSessionCookie(req));
  if (!cookieUser) return res.status(401).json({ detail: 'Not signed in — finish the Tesla OAuth flow first.' });

  const vid = String(vehicle_id);
  const vname = vehicle_name || 'Unknown';
  const isStub = isStubVehicle(vid);
  if (!isStub && (!cookieUser.refresh_token || cookieUser.refresh_invalidated_at)) {
    return res.status(409).json({ detail: 'Tesla authorization missing or expired — re-authorize first.' });
  }

  const patch = { slack_user_id, vehicle_id: vid, vehicle_name: vname, ...FRESH_SUB_TELEMETRY };
  // Stub vehicle → force the sentinel so the cron short-circuits (it
  // branches on refresh_token === STUB_REFRESH_TOKEN before any Tesla
  // call). Real vehicle → the record's refresh_token is kept.
  if (isStub) patch.refresh_token = STUB_REFRESH_TOKEN;
  patchUser(cookieUser.id, patch);
  clearOtherSubs(slack_user_id, cookieUser.id);
  console.log(`[notifications] enabled slack=${slack_user_id} vehicle=${vid} record=${cookieUser.id.slice(0, 8)}`);

  // Best-effort confirmation DM — failure doesn't undo the sub; surface
  // the error so the SPA can hint at it.
  const dm = await postSlackDM(
    slack_user_id,
    `:car: Tesla sweeper notifications enabled for *${vname}*. I'll DM you 1, 2, and 3 days before each sweep at noon ET. Disable anytime at https://sweeper.bitvox.me/.`
  );
  res.json({ enabled: true, id: cookieUser.id, test_dm_ok: dm.ok, test_dm_error: dm.error || null });
}));

notificationsRouter.post('/api/notifications/disable', wrap(async (req, res) => {
  const { id, slack_user_id, slack_session } = req.body || {};
  if (!id || !slack_user_id) return res.status(400).json({ detail: 'id and slack_user_id required' });
  if (!verifySession(slack_session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  const user = loadUserById(id);
  if (!user || user.slack_user_id !== slack_user_id) return res.status(404).json({ detail: 'Subscription not found' });
  // Clear the sub fields. Keep the record if a browser session is still
  // bound to it (logged-in-but-unsubscribed); otherwise it's empty —
  // delete it. No Tesla session cookie required: a user whose Tesla
  // auth lapsed must still be able to stop the DMs.
  if (user.session_cookie_id) patchUser(id, CLEARED_SUB);
  else deleteUser(id);
  console.log(`[notifications] disabled slack=${slack_user_id} record=${id.slice(0, 8)}`);
  res.json({ disabled: true });
}));

notificationsRouter.get('/api/notifications/status', (req, res) => {
  const { slack_user_id } = req.query;
  if (!slack_user_id) return res.status(400).json({ detail: 'slack_user_id required' });
  res.json({ subscriptions: loadSubscribedUsers().filter(u => u.slack_user_id === slack_user_id).map(publicUser) });
});

// Manual trigger / monitoring endpoint. Same logic the in-process
// noon-ET cron calls.
notificationsRouter.post('/api/notifications/run', wrap(async (req, res) => {
  if (!bearerOk(req.get('authorization') || '', NOTIFICATIONS_RUN_TOKEN)) {
    return res.status(401).json({ detail: 'Unauthorized' });
  }
  res.json(await runNotifications());
}));

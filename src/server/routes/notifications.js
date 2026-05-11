// Subscription endpoints for daily sweep notifications + manual /run.
//
// /enable + /disable are HMAC-gated on the Slack session — that's the
// confused-deputy fix (a Tesla refresh_token alone shouldn't let you
// subscribe an arbitrary slack_user_id). The Slack HMAC is the ONLY gate
// on /disable: a user whose Tesla session has expired must still be able
// to stop the DMs (re-do Slack OIDC → /disable, no Tesla OAuth needed).
//
// BFF (Phase 6): under the cookie path /enable reuses the cookie-bound
// user record's server-owned refresh_token (no refresh_token in the
// body); the legacy body path — `{refresh_token, ...}` — still works for
// one release (a stale cached SPA) and creates a fresh record. One
// subscription per slack_user_id, deliberately (multi-vehicle is a
// separate, out-of-scope feature).

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { verifySession } from '../crypto/session.js';
import { bearerOk } from '../crypto/bearer.js';
import {
  blankUser, createUser, deleteUser, patchUser,
  loadUsers, loadUserById, loadUserBySession, loadSubscribedUsers, publicUser,
} from '../store/users.js';
import { readSessionCookie } from '../util/session.js';
import { STUB_REFRESH_TOKEN, isStubVehicle, teslaTokenExchange } from '../integrations/tesla.js';
import { postSlackDM } from '../integrations/slack.js';
import { runNotifications } from '../notifications/cron.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

export const notificationsRouter = Router();

// One subscription per slack_user_id. Clears the slack/vehicle fields on
// every record for `slackUserId` except `keepId`; a record that ends up
// with neither a sub nor a session-cookie binding is deleted outright.
// (Handles e.g. a pre-BFF migrated record that /session/create couldn't
// match by tesla_account_id, leaving a stale duplicate sub behind.)
function clearOtherSubs(slackUserId, keepId) {
  for (const u of loadUsers()) {
    if (u.id === keepId || u.slack_user_id !== slackUserId) continue;
    if (u.session_cookie_id) patchUser(u.id, { slack_user_id: null, vehicle_id: null, vehicle_name: null });
    else deleteUser(u.id);
    console.log(`[notifications] removed duplicate sub on record ${u.id.slice(0, 8)} for ${slackUserId}`);
  }
}

notificationsRouter.post('/api/notifications/enable', wrap(async (req, res) => {
  const { refresh_token, vehicle_id, vehicle_name, slack_user_id, session, slack_session } = req.body || {};
  if (!vehicle_id || !slack_user_id) return res.status(400).json({ detail: 'vehicle_id and slack_user_id are required' });
  // Confused-deputy gate (both paths): slack_user_id must arrive paired
  // with a server-issued HMAC session minted on a verified Slack OIDC
  // callback for that id. Legacy clients send `session`; the new SPA
  // sends `slack_session` — accept either.
  if (!verifySession(slack_session || session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  if (!SLACK_USER_ID_RE.test(slack_user_id)) return res.status(400).json({ detail: 'slack_user_id should look like U060NLFUM' });

  const vid = String(vehicle_id);
  const vname = vehicle_name || 'Unknown';
  const isStub = isStubVehicle(vid);

  // Cookie path wins: the SPA already OAuthed via /api/session/create, so
  // the cookie-bound record holds the canonical refresh_token.
  const cookieUser = loadUserBySession(readSessionCookie(req));
  let recordId;
  if (cookieUser) {
    if (!isStub && (!cookieUser.refresh_token || cookieUser.refresh_invalidated_at)) {
      return res.status(409).json({ detail: 'Tesla authorization missing or expired — re-authorize first.' });
    }
    const patch = { slack_user_id, vehicle_id: vid, vehicle_name: vname };
    // Stub vehicle → force the sentinel so the cron short-circuits
    // (it branches on refresh_token === STUB_REFRESH_TOKEN before any
    // Tesla call). Real vehicle → the record's refresh_token is kept.
    if (isStub) patch.refresh_token = STUB_REFRESH_TOKEN;
    patchUser(cookieUser.id, patch);
    recordId = cookieUser.id;
    clearOtherSubs(slack_user_id, cookieUser.id);
  } else {
    // Legacy body path — needs an explicit refresh_token. Validate it by
    // exchanging once (Tesla rotates on every exchange, so persist the
    // rotated value), then create a fresh record.
    if (!refresh_token) return res.status(400).json({ detail: 'refresh_token is required (no session cookie)' });
    let stored = STUB_REFRESH_TOKEN;
    if (!isStub) {
      let rotated;
      try { rotated = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token }); }
      catch (e) { return res.status(400).json({ detail: 'Refresh token invalid: ' + e.message }); }
      stored = rotated.refresh_token || refresh_token;
    }
    clearOtherSubs(slack_user_id, null);
    recordId = createUser(blankUser({ slack_user_id, vehicle_id: vid, vehicle_name: vname, refresh_token: stored })).id;
  }
  console.log(`[notifications] enabled slack=${slack_user_id} vehicle=${vid} record=${recordId.slice(0, 8)} via=${cookieUser ? 'cookie' : 'body'}`);

  // Best-effort confirmation DM — failure doesn't undo the sub; surface
  // the error so the SPA can hint at it.
  const dm = await postSlackDM(
    slack_user_id,
    `:car: Tesla sweeper notifications enabled for *${vname}*. I'll DM you 1, 2, and 3 days before each sweep at noon ET. Disable anytime at https://sweeper.bitvox.me/.`
  );
  res.json({ enabled: true, id: recordId, test_dm_ok: dm.ok, test_dm_error: dm.error || null });
}));

notificationsRouter.post('/api/notifications/disable', wrap(async (req, res) => {
  const { id, slack_user_id, session, slack_session } = req.body || {};
  if (!id || !slack_user_id) return res.status(400).json({ detail: 'id and slack_user_id required' });
  if (!verifySession(slack_session || session, slack_user_id)) {
    return res.status(403).json({ detail: 'Slack session expired or mismatched. Sign in with Slack again.' });
  }
  const user = loadUserById(id);
  if (!user || user.slack_user_id !== slack_user_id) return res.status(404).json({ detail: 'Subscription not found' });
  // Clear the sub fields. Keep the record if a browser session is still
  // bound to it (logged-in-but-unsubscribed); otherwise it's empty —
  // delete it. No Tesla session cookie required: a user whose Tesla
  // auth lapsed must still be able to stop the DMs.
  if (user.session_cookie_id) patchUser(id, { slack_user_id: null, vehicle_id: null, vehicle_name: null });
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

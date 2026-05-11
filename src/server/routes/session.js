// BFF session endpoints. The browser's only credential is a signed,
// HttpOnly `session` cookie; the server owns the Tesla refresh_token and
// brokers access via getTeslaAccess (see integrations/tesla-auth.js).
//
//   POST /api/session/create  { code, state }  → exchange the Tesla OAuth
//     code, resolve the account id, find-or-create the user record, bind
//     a fresh cookie, return the vehicle list.
//   POST /api/session/destroy (cookie)         → unbind the cookie;
//     best-effort revoke the refresh_token at Tesla IF no notification
//     sub still needs it; clear the cookie. 204.
//   GET  /api/session/me      (cookie)         → SPA mount bootstrap.
//
// See docs/bff-token-ownership-plan.md "Phase 5".

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { wrap } from '../middleware/errors.js';
import { teslaTokenExchange, listVehicles, TESLA_BASE } from '../integrations/tesla.js';
import { fetchWithTimeout } from '../util/fetch.js';
import { consumeState } from '../util/oauth-state.js';
import {
  blankUser, createUser, patchUser,
  loadUserBySession, loadUserByTeslaAccountId,
} from '../store/users.js';
import { mintSessionId, readSessionCookie, setSessionCookie, clearSessionCookie } from '../util/session.js';

const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const TESLA_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const TESLA_REVOKE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/revoke';
const DEFAULT_ACCESS_TTL_S = 8 * 60 * 60; // Tesla access_tokens are ~8h

const sid8 = (sid) => (sid ? sid.slice(0, 8) : '?');

// Resolve a stable Tesla account id to key find-or-create on.
//
// Primary: the OIDC `id_token` `sub` claim (Tesla returns an id_token
// when `openid` is in scope, which /api/oauth/app/start requests). We
// trust it implicitly — it arrived straight from
// fleet-auth.prd.vn.cloud.tesla.com over TLS in the same exchange; a
// forger able to inject here could just as easily hand us a working
// access_token for any account. We only parse out `sub` and sanity-check
// `exp`. Unlike the Slack handler we don't pin `iss`/`aud`: Tesla's OIDC
// issuer string isn't reliably documented and a bad guess would
// hard-break login.
//
// Fallback: `GET /api/1/users/me` with the fresh access_token, keyed on
// `vault_uuid` (or `email`). Last resort: a synthetic id — the session
// still works, but a later re-OAuth makes a new record instead of
// reusing this one. Logged so it's visible.
async function resolveTeslaAccountId(tokenData) {
  const idToken = tokenData.id_token;
  if (typeof idToken === 'string' && idToken.split('.').length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
      // Require exp present-and-future before trusting any claim — mirrors
      // the Slack id_token check in routes/oauth.js (a missing exp must not
      // be a free pass).
      if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('id_token exp missing or expired');
      if (typeof claims.sub === 'string' && claims.sub) return claims.sub;
    } catch (e) {
      console.warn(`[session] id_token unusable (${e.message}) — falling back to /api/1/users/me`);
    }
  }
  try {
    const res = await fetchWithTimeout(`${TESLA_BASE}/api/1/users/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const me = (await res.json().catch(() => ({}))).response || {};
      if (me.vault_uuid) return String(me.vault_uuid);
      if (me.email) return `email:${me.email}`;
    }
  } catch (e) {
    console.warn(`[session] /api/1/users/me failed: ${e.message}`);
  }
  const synthetic = `synthetic:${randomBytes(16).toString('hex')}`;
  console.warn(`[session] no Tesla account id available — using ${synthetic.slice(0, 18)}…`);
  return synthetic;
}

export const sessionRouter = Router();

sessionRouter.post('/api/session/create', wrap(async (req, res) => {
  const { code, state } = req.body || {};
  if (!code) return res.status(400).json({ detail: 'code required' });
  // Mint the cookie up front: if SESSION_HMAC_KEY is unset, bail BEFORE
  // burning the one-shot OAuth `state` (and the one-shot OAuth `code` at
  // Tesla). Cheap to mint a sid even if we end up not using it.
  const { sid, signed } = mintSessionId();
  if (!signed) return res.status(503).json({ detail: 'Session signing unavailable (SESSION_HMAC_KEY unset)' });
  if (!consumeState(state, 'tesla')) return res.status(400).json({ detail: 'invalid or expired state' });

  const tokenData = await teslaTokenExchange({
    grant_type: 'authorization_code', client_id: TESLA_CLIENT_ID, client_secret: TESLA_CLIENT_SECRET,
    code, redirect_uri: TESLA_REDIRECT_URI, audience: TESLA_BASE,
  });
  if (!tokenData.access_token || !tokenData.refresh_token) {
    console.error('[session] code exchange returned an incomplete token set');
    return res.status(502).json({ detail: 'Tesla token exchange failed' });
  }

  const accountId = await resolveTeslaAccountId(tokenData);
  const access_expires_at = new Date(Date.now() + (tokenData.expires_in || DEFAULT_ACCESS_TTL_S) * 1000).toISOString();
  const now = new Date().toISOString();
  const tokenFields = {
    tesla_account_id: accountId,
    refresh_token: tokenData.refresh_token,
    access_token: tokenData.access_token,
    access_expires_at,
    refresh_invalidated_at: null,
    session_cookie_id: sid,
    last_seen_at: now,
  };

  const existing = loadUserByTeslaAccountId(accountId);
  if (existing) {
    patchUser(existing.id, tokenFields);
    console.log(`[session] created sid=${sid8(sid)} slack=${existing.slack_user_id || 'none'} (reused record)`);
  } else {
    createUser(blankUser({ ...tokenFields, created_at: now }));
    console.log(`[session] created sid=${sid8(sid)} slack=none (new record)`);
  }
  setSessionCookie(res, signed);

  let vehicles;
  try { vehicles = await listVehicles(tokenData.access_token); }
  catch (e) {
    console.error(`[session] post-login vehicle list fetch failed: ${e.message}`);
    return res.status(502).json({ detail: 'Signed in, but the vehicle list failed to load — reload to retry.' });
  }
  res.json({ vehicles });
}));

sessionRouter.post('/api/session/destroy', wrap(async (req, res) => {
  const sid = readSessionCookie(req);
  clearSessionCookie(res); // always clear the browser cookie, even for a junk/absent sid
  const user = loadUserBySession(sid);
  if (user) {
    const subRetained = !!(user.slack_user_id && user.vehicle_id);
    patchUser(user.id, { session_cookie_id: null });
    console.log(`[session] destroyed sid=${sid8(sid)}${subRetained ? ' (sub retained)' : ''}`);
    // No notification sub uses this record's token → it's now orphaned.
    // Best-effort revoke at Tesla so a stolen-laptop logout actually
    // kills the credential server-side, then null it locally. If a sub
    // DOES use it, leave the token alone — the cron needs it.
    if (!subRetained && user.refresh_token && !user.refresh_invalidated_at) {
      try {
        const r = await fetchWithTimeout(TESLA_REVOKE_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: user.refresh_token, token_type_hint: 'refresh_token', client_id: TESLA_CLIENT_ID }).toString(),
        });
        if (!r.ok) console.warn(`[session] token revoke returned ${r.status} (best-effort, ignoring)`);
      } catch (e) { console.warn(`[session] token revoke failed: ${e.message} (best-effort, ignoring)`); }
      patchUser(user.id, { refresh_token: null, access_token: null, access_expires_at: null });
    }
  }
  res.status(204).end();
}));

sessionRouter.get('/api/session/me', (req, res) => {
  const user = loadUserBySession(readSessionCookie(req));
  if (!user) return res.json({ authenticated: false, slack_user_id: null, vehicle_id: null, vehicle_name: null });
  res.json({
    authenticated: true,
    slack_user_id: user.slack_user_id ?? null,
    vehicle_id: user.vehicle_id ?? null,
    vehicle_name: user.vehicle_name ?? null,
  });
});

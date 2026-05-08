// Tesla Fleet API OAuth2 + Slack OIDC handlers. client_secret stays
// server-side; Slack callback mints an HMAC session bound to the
// verified slack_user_id (used by /enable + /disable).

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { wrap } from '../middleware/errors.js';
import { teslaTokenExchange, TESLA_BASE } from '../integrations/tesla.js';
import { signSession } from '../crypto/session.js';
import { fetchWithTimeout } from '../util/fetch.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_APP_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const TESLA_APP_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';

// Server-side OAuth `state` registry. /start mints + records, /callback
// requires a matching+unconsumed entry. Defends against CSRF beyond the
// SPA's localStorage check (which an attacker who controls the SPA
// origin could circumvent). 10min TTL covers a sane redirect→exchange
// window; entries are deleted on use (one-shot).
const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map();
function mintState(type) {
  const state = randomBytes(32).toString('base64url');
  stateStore.set(state, { type, expires_at: Date.now() + STATE_TTL_MS });
  // Lazy GC on each mint — keeps the map from growing unbounded if a
  // user starts but never finishes flows. O(N) but N ≤ a handful.
  const now = Date.now();
  for (const [k, v] of stateStore) if (v.expires_at < now) stateStore.delete(k);
  return state;
}
function consumeState(state, expectedType) {
  if (!state) return false;
  const entry = stateStore.get(state);
  if (!entry || entry.expires_at < Date.now() || entry.type !== expectedType) return false;
  stateStore.delete(state);
  return true;
}

export const oauthRouter = Router();

oauthRouter.post('/api/oauth/app/start', (req, res) => {
  if (!TESLA_APP_CLIENT_ID) return res.status(500).json({ detail: 'App OAuth not configured' });
  const state = mintState('tesla');
  const scope = 'openid offline_access vehicle_device_data vehicle_location';
  const params = new URLSearchParams({ response_type: 'code', client_id: TESLA_APP_CLIENT_ID, redirect_uri: TESLA_APP_REDIRECT_URI, scope, state, prompt: 'login', locale: 'en-US' });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
});

oauthRouter.post('/api/oauth/app/callback', wrap(async (req, res) => {
  const { code, state } = req.body;
  if (!code) return res.status(400).json({ detail: 'code required' });
  if (!consumeState(state, 'tesla')) return res.status(400).json({ detail: 'invalid or expired state' });
  console.log('[oauth/app] Exchanging code for token');
  const data = await teslaTokenExchange({
    grant_type: 'authorization_code', client_id: TESLA_APP_CLIENT_ID, client_secret: TESLA_APP_CLIENT_SECRET,
    code, redirect_uri: TESLA_APP_REDIRECT_URI, audience: TESLA_BASE,
  });
  console.log('[oauth/app] Token obtained, expires_in:', data.expires_in);
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, token_type: data.token_type });
}));

oauthRouter.post('/api/oauth/app/refresh', wrap(async (req, res) => {
  const { refresh_token } = req.body;
  const data = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token });
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
}));

// "Sign in with Slack" — OIDC flow so users can subscribe to
// notifications without hunting for their member id.
oauthRouter.post('/api/slack/oauth/start', (req, res) => {
  if (!SLACK_CLIENT_ID) return res.status(500).json({ detail: 'Slack OAuth not configured' });
  const state = mintState('slack');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SLACK_CLIENT_ID,
    scope: 'openid profile',
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });
  res.json({ url: `https://slack.com/openid/connect/authorize?${params}`, state });
});

oauthRouter.post('/api/slack/oauth/callback', wrap(async (req, res) => {
  const { code, state } = req.body;
  if (!code) return res.status(400).json({ detail: 'code required' });
  if (!consumeState(state, 'slack')) return res.status(400).json({ detail: 'invalid or expired state' });
  const tokenRes = await fetchWithTimeout('https://slack.com/api/openid.connect.token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      redirect_uri: SLACK_REDIRECT_URI,
      code,
    }).toString(),
  });
  const data = await tokenRes.json();
  if (!data.ok) throw new Error(data.error || 'Slack token exchange failed');
  if (!data.id_token) throw new Error('Slack returned no id_token');
  // Decode the id_token JWT. We trust the signature implicitly because
  // we got it directly from Slack over TLS in this same exchange — but
  // we still verify iss/aud/exp on the claims as defense-in-depth, so
  // a Slack response shape regression or upstream proxy that injects a
  // foreign id_token can't mint a session for an attacker's user_id.
  const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
  if (claims.iss !== 'https://slack.com') throw new Error('Slack id_token: bad iss');
  if (claims.aud !== SLACK_CLIENT_ID) throw new Error('Slack id_token: bad aud');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('Slack id_token: expired');
  const slackUserId = claims['https://slack.com/user_id'];
  if (!slackUserId) throw new Error('Slack id_token: missing user_id');
  res.json({
    slack_user_id: slackUserId,
    team_id: claims['https://slack.com/team_id'],
    email: claims.email,
    name: claims.name,
    // Short-lived HMAC token tied to the verified slack_user_id —
    // SPA passes it on subsequent /enable + /disable calls so the
    // server can prove the requester actually owns the slack id.
    session: signSession(slackUserId),
  });
}));

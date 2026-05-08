// Tesla Fleet API OAuth2 + Slack OIDC handlers. Both keep credentials
// server-side: the SPA only sees codes and id_tokens, never the
// client_secret. Slack callback also mints an HMAC session token bound
// to the verified slack_user_id (used by /enable + /disable).

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { wrap } from '../middleware/errors.js';
import { teslaTokenExchange, TESLA_BASE } from '../integrations/tesla.js';
import { signSession } from '../crypto/session.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_APP_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const TESLA_APP_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';
const FETCH_TIMEOUT = 12000;

const fetchWithTimeout = (url, options = {}) =>
  fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });

export const oauthRouter = Router();

oauthRouter.post('/api/oauth/app/start', (req, res) => {
  if (!TESLA_APP_CLIENT_ID) return res.status(500).json({ detail: 'App OAuth not configured' });
  const state = randomBytes(32).toString('base64url');
  const scope = 'openid offline_access vehicle_device_data vehicle_location';
  const params = new URLSearchParams({ response_type: 'code', client_id: TESLA_APP_CLIENT_ID, redirect_uri: TESLA_APP_REDIRECT_URI, scope, state, prompt: 'login', locale: 'en-US' });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
});

oauthRouter.post('/api/oauth/app/callback', wrap(async (req, res) => {
  const { code } = req.body;
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
  const state = randomBytes(32).toString('base64url');
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
  const { code } = req.body;
  if (!code) return res.status(400).json({ detail: 'code required' });
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
  // Decode the id_token JWT instead of a second userInfo round-trip.
  // Slack signed it and we got it over TLS in the same exchange, so
  // signature verification adds no security at this seam.
  const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
  res.json({
    slack_user_id: claims['https://slack.com/user_id'],
    team_id: claims['https://slack.com/team_id'],
    email: claims.email,
    name: claims.name,
    // Short-lived HMAC token tied to the verified slack_user_id —
    // SPA passes it on subsequent /enable + /disable calls so the
    // server can prove the requester actually owns the slack id.
    session: signSession(claims['https://slack.com/user_id']),
  });
}));

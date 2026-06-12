// OAuth entry points: the Tesla Fleet API authorize-URL builder (the
// code exchange itself lives in routes/session.js → /api/session/create
// now) and the "Sign in with Slack" OIDC flow. The Slack callback mints
// an HMAC session bound to the verified slack_user_id (used by /enable +
// /disable); client_secret stays server-side.

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { signSession } from '../crypto/session.js';
import { fetchWithTimeout } from '../util/fetch.js';
import { mintState, consumeState } from '../util/oauth-state.js';
import { saveInstall } from '../store/slack-install.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_APP_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';
const SLACK_INSTALL_REDIRECT_URI = process.env.SLACK_INSTALL_REDIRECT_URI || '';
const SLACK_TEAM_ID = process.env.SLACK_TEAM_ID || '';

export const oauthRouter = Router();

oauthRouter.post('/api/oauth/app/start', (req, res) => {
  if (!TESLA_APP_CLIENT_ID) return res.status(500).json({ detail: 'App OAuth not configured' });
  const state = mintState('tesla');
  if (!state) return res.status(503).json({ detail: 'OAuth state registry full — try again' });
  const scope = 'openid offline_access vehicle_device_data vehicle_location';
  const params = new URLSearchParams({ response_type: 'code', client_id: TESLA_APP_CLIENT_ID, redirect_uri: TESLA_APP_REDIRECT_URI, scope, state, prompt: 'login', locale: 'en-US' });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
});

// "Sign in with Slack" — OIDC flow so users can subscribe to
// notifications without hunting for their member id.
oauthRouter.post('/api/slack/oauth/start', (req, res) => {
  if (!SLACK_CLIENT_ID) return res.status(500).json({ detail: 'Slack OAuth not configured' });
  const state = mintState('slack');
  if (!state) return res.status(503).json({ detail: 'OAuth state registry full — try again' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SLACK_CLIENT_ID,
    scope: 'openid profile',
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });
  res.json({ url: `https://slack.com/openid/connect/authorize?${params}`, state });
});

// Bot-install flow ("Add to Slack") — distinct from the OIDC sign-in
// above: this mints the workspace xoxb token the cron DMs run on. The
// callback persists it server-side (data/slack-install.json, file-first
// in integrations/slack.js) so no human ever handles the token; a
// reinstall/rescope is just re-running this flow.
oauthRouter.post('/api/slack/oauth/install/start', (req, res) => {
  if (!SLACK_CLIENT_ID || !SLACK_INSTALL_REDIRECT_URI) return res.status(500).json({ detail: 'Slack install not configured' });
  const state = mintState('slack-install');
  if (!state) return res.status(503).json({ detail: 'OAuth state registry full — try again' });
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: 'chat:write,im:write',
    redirect_uri: SLACK_INSTALL_REDIRECT_URI,
    state,
  });
  res.json({ url: `https://slack.com/oauth/v2/authorize?${params}`, state });
});

oauthRouter.get('/api/slack/oauth/install-callback', rateLimit({ perMinute: 6 }), wrap(async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ detail: 'code required' });
  if (!consumeState(state, 'slack-install')) return res.status(400).json({ detail: 'invalid or expired state' });
  const tokenRes = await fetchWithTimeout('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      redirect_uri: SLACK_INSTALL_REDIRECT_URI,
      code,
    }).toString(),
  });
  const data = await tokenRes.json();
  if (!data.ok) throw new Error(data.error || 'Slack install exchange failed');
  // Workspace pin: anyone can walk this flow against their OWN workspace
  // (install/start is unauthenticated, matching the other start routes) —
  // without the pin, the resulting foreign token would clobber ours and
  // silently kill every DM. Reject any team but the configured one.
  if (SLACK_TEAM_ID && data.team?.id !== SLACK_TEAM_ID) return res.status(403).json({ detail: 'wrong workspace' });
  if (!data.access_token) throw new Error('Slack install: no access_token in response');
  saveInstall({
    access_token: data.access_token,
    bot_user_id: data.bot_user_id || null,
    team_id: data.team?.id || null,
    team_name: data.team?.name || null,
    scope: data.scope || null,
  });
  res.type('text/plain').send('sweeper installed — bot token captured server-side. you can close this tab.');
}));

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

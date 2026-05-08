import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'fs';
import { wrap } from './middleware/errors.js';
import { brotliMiddleware } from './middleware/brotli.js';
import { signSession, verifySession } from './crypto/session.js';
import { bearerOk } from './crypto/bearer.js';
import { loadStore, loadSubs, saveSubs, publicSub } from './store/subscriptions.js';
import {
  STUB_VEHICLE_ENABLED, STUB_VEHICLE_ID, STUB_VEHICLE_VIN, STUB_VEHICLE_LAT, STUB_VEHICLE_LNG,
  STUB_VEHICLE_NAME, STUB_REFRESH_TOKEN, isStubVehicle,
  teslaTokenExchange, fetchVehicleData, TESLA_BASE, UA, FETCH_TIMEOUT,
} from './integrations/tesla.js';
import { postSlackDM } from './integrations/slack.js';
import { reverseGeocodeLocation } from './integrations/nominatim.js';
import { whichSide } from './integrations/overpass.js';
import { runSweepCheck } from './sweep/check.js';
import { runNotifications, startNotificationCron, maybeRecoverMissedRun, maybeRecoverMissedDigest } from './notifications/cron.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root-relative paths anchor on this file's location after the
// src/server/index.js move. Every `data/`, `dist/`, and `.env` reference
// goes through here so a move never silently drifts to a wrong path.
const REPO_ROOT = join(__dirname, '..', '..');

// Load .env
try {
  for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const app = express();
app.use(express.json({ limit: '10kb' }));

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_APP_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const TESLA_APP_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;
const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
}

// List vehicles on account
app.post('/api/vehicles', wrap(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ detail: 'Token required' });

  console.log('[vehicles] Fetching vehicle list');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const vehiclesRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles`, { headers });

  if (vehiclesRes.status === 401) {
    console.log('[vehicles] 401 — token invalid or expired');
    return res.status(401).json({ detail: 'Invalid or expired Tesla token' });
  }
  if (!vehiclesRes.ok) {
    const errBody = await vehiclesRes.text().catch(() => '');
    console.error('[vehicles] Tesla API error:', vehiclesRes.status, errBody);
    return res.status(vehiclesRes.status).json({ detail: `Tesla API error (${vehiclesRes.status})` });
  }

  const vehicles = (await vehiclesRes.json()).response || [];
  console.log(`[vehicles] Found ${vehicles.length} vehicle(s)`);
  const out = vehicles.map(v => ({ id: v.id, name: v.display_name || 'Unknown', vin: v.vin, state: v.state }));
  if (STUB_VEHICLE_ENABLED && out.length === 0) {
    console.log('[vehicles] injecting stub test vehicle');
    out.push({ id: STUB_VEHICLE_ID, name: STUB_VEHICLE_NAME, vin: STUB_VEHICLE_VIN, state: 'online' });
  }
  res.json({ vehicles: out });
}));

// Get location for a specific vehicle
app.post('/api/check', wrap(async (req, res) => {
  const { token, vehicle_id } = req.body;
  if (!token) return res.status(400).json({ detail: 'Token required' });

  // Stub short-circuit: skip Tesla wake/poll entirely.
  if (isStubVehicle(vehicle_id)) {
    console.log('[check] returning stub vehicle data');
    return res.json({
      vehicle_name: STUB_VEHICLE_NAME,
      latitude: STUB_VEHICLE_LAT,
      longitude: STUB_VEHICLE_LNG,
      battery_level: 78,
    });
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let vid = vehicle_id;
  if (!vid) {
    const vehiclesRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles`, { headers });
    if (vehiclesRes.status === 401) return res.status(401).json({ detail: 'Invalid or expired Tesla token' });
    if (!vehiclesRes.ok) return res.status(vehiclesRes.status).json({ detail: 'Tesla API error' });
    const vehicles = (await vehiclesRes.json()).response || [];
    if (!vehicles.length) return res.json({ no_vehicles: true });
    vid = vehicles[0].id;
  }

  console.log(`[check] Getting location for vehicle ${vid}`);
  const locData = await fetchVehicleData(headers, vid);
  const { latitude, longitude } = locData.response?.drive_state || {};
  console.log(`[check] Location: ${latitude}, ${longitude}`);
  if (latitude == null || longitude == null) return res.status(404).json({ detail: 'Could not determine vehicle location' });
  res.json({
    vehicle_name: locData.response?.display_name || locData.response?.vehicle_config?.car_type || 'Unknown',
    latitude,
    longitude,
    battery_level: locData.response?.charge_state?.battery_level,
  });
}));

app.post('/api/reverse-geocode', wrap(async (req, res) => {
  const { lat, lng } = req.body;
  res.json(await reverseGeocodeLocation(lat, lng));
}));

app.post('/api/which-side', wrap(async (req, res) => {
  const { lat, lng } = req.body;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ detail: 'lat and lng required as finite numbers in valid range' });
  }
  res.json(await whichSide(lat, lng));
}));

app.post('/api/sweep-check', wrap(async (req, res) => {
  const { address, today_date, past_noon, lat, lng } = req.body;
  if (!address) return res.status(400).json({ detail: 'Address required' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ detail: 'lat and lng required as finite numbers in valid range' });
  }
  res.json(await runSweepCheck({ address, today_date, past_noon, lat, lng }));
}));

// Pre-configured app OAuth — credentials stay server-side
app.post('/api/oauth/app/start', (req, res) => {
  if (!TESLA_APP_CLIENT_ID) return res.status(500).json({ detail: 'App OAuth not configured' });
  const state = randomBytes(32).toString('base64url');
  const scope = 'openid offline_access vehicle_device_data vehicle_location';
  const params = new URLSearchParams({ response_type: 'code', client_id: TESLA_APP_CLIENT_ID, redirect_uri: TESLA_APP_REDIRECT_URI, scope, state, prompt: 'login', locale: 'en-US' });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
});

app.post('/api/oauth/app/callback', wrap(async (req, res) => {
  const { code } = req.body;
  console.log('[oauth/app] Exchanging code for token');
  const data = await teslaTokenExchange({
    grant_type: 'authorization_code', client_id: TESLA_APP_CLIENT_ID, client_secret: TESLA_APP_CLIENT_SECRET,
    code, redirect_uri: TESLA_APP_REDIRECT_URI, audience: TESLA_BASE,
  });
  console.log('[oauth/app] Token obtained, expires_in:', data.expires_in);
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, token_type: data.token_type });
}));

app.post('/api/oauth/app/refresh', wrap(async (req, res) => {
  const { refresh_token } = req.body;
  const data = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token });
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
}));

// "Sign in with Slack" — OIDC flow so users can subscribe to
// notifications without hunting for their member id.
app.post('/api/slack/oauth/start', (req, res) => {
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

app.post('/api/slack/oauth/callback', wrap(async (req, res) => {
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

// Daily-notification subscription endpoints. Stores the user's Tesla
// refresh_token server-side so a 12pm ET cron can wake the car, check
// the sweeping schedule, and DM via Slack on T-3/T-2/T-1.
app.post('/api/notifications/enable', wrap(async (req, res) => {
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
  // Stub bypass: skip Tesla refresh + vehicle-id lookup. The cron
  // path branches on STUB_REFRESH_TOKEN to short-circuit too.
  let storedRefreshToken = STUB_REFRESH_TOKEN;
  if (!isStubVehicle(vehicle_id)) {
    // Validate the refresh_token by doing one round-trip. Catches typos
    // and revoked tokens before we persist garbage.
    let rotated;
    try {
      rotated = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token });
    } catch (e) {
      return res.status(400).json({ detail: 'Refresh token invalid: ' + e.message });
    }
    // Confirm the supplied vehicle_id is reachable with this token —
    // otherwise the cron 404s daily forever. Tesla vehicle IDs are
    // 16-digit ints above MAX_SAFE_INTEGER, so JSON round-tripping
    // can lose precision and === will silently miss. Compare as strings.
    try {
      const vr = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' },
      });
      const list = vr.ok ? ((await vr.json()).response || []) : [];
      if (!list.some(v => String(v.id) === String(vehicle_id))) {
        return res.status(400).json({ detail: 'vehicle_id not on this Tesla account' });
      }
    } catch (e) {
      return res.status(502).json({ detail: 'Tesla vehicles lookup failed: ' + e.message });
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
    vehicle_id,
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

app.post('/api/notifications/disable', wrap(async (req, res) => {
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

app.get('/api/notifications/status', (req, res) => {
  const { slack_user_id } = req.query;
  if (!slack_user_id) return res.status(400).json({ detail: 'slack_user_id required' });
  res.json({ subscriptions: loadSubs().filter(s => s.slack_user_id === slack_user_id).map(publicSub) });
});



// Manual trigger / monitoring endpoint. Same logic the in-process
// noon-ET cron calls.
app.post('/api/notifications/run', wrap(async (req, res) => {
  if (!bearerOk(req.get('authorization') || '', NOTIFICATIONS_RUN_TOKEN)) {
    return res.status(401).json({ detail: 'Unauthorized' });
  }
  res.json(await runNotifications());
}));

// Liveness/ops probe — `last_run_at` answers "is the cron working"
// in one curl. Cheap, no auth, no PII.
app.get('/healthz', (req, res) => {
  const store = loadStore();
  res.json({
    ok: true,
    last_run_at: store.last_run_at || null,
    last_digest_run_at: store.last_digest_run_at || null,
    sub_count: (store.subscriptions || []).length,
  });
});

// API 404 catch — must be before the SPA catch-all
app.all('/api/*', (req, res) => res.status(404).json({ detail: 'API endpoint not found' }));

app.use(brotliMiddleware(join(REPO_ROOT, 'dist')));
app.use(express.static(join(REPO_ROOT, 'dist')));
app.get('*', (req, res) => res.sendFile(join(REPO_ROOT, 'dist', 'index.html')));

// Exit on uncaught exceptions — continuing leaves the process in
// undefined state (mid-write file handles, half-rotated tokens).
// systemd will restart cleanly via Restart=on-failure.
process.on('uncaughtException', (e) => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const PORT = process.env.PORT || 20040;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`);
  startNotificationCron();
  maybeRecoverMissedRun();
  maybeRecoverMissedDigest();
});

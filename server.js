import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const app = express();
app.use(express.json());

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_APP_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
const TESLA_APP_REDIRECT_URI = process.env.TESLA_REDIRECT_URI || '';
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const RECOLLECT_BASE = 'https://api.recollect.net/api';
const RECOLLECT_SERVICE = 349;
const UA = 'TeslaSweeper/1.0';
const FETCH_TIMEOUT = 12000;
const VEHICLE_DATA_QS = 'endpoints=location_data%3Bcharge_state';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

const wrap = (fn) => (req, res) => fn(req, res).catch(e => {
  console.error(`${req.path}:`, e.message);
  res.status(502).json({ detail: 'Upstream service error' });
});

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
}

// Nominatim rate limiter (1 req/sec)
let lastNominatimCall = 0;
async function nominatimFetch(url, options) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastNominatimCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimCall = Date.now();
  return fetchWithTimeout(url, options);
}

const TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

// Subscriptions for daily sweep notifications. File holds Tesla
// refresh_tokens — mode 0600, never logged. Atomic write via temp+rename
// so a crash mid-write doesn't truncate the store.
const SUBS_DIR = join(__dirname, 'data');
const SUBS_FILE = join(SUBS_DIR, 'subscriptions.json');
const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';
mkdirSync(SUBS_DIR, { recursive: true, mode: 0o700 });
function loadSubs() {
  try {
    return JSON.parse(readFileSync(SUBS_FILE, 'utf8')).subscriptions || [];
  } catch { return []; }
}
function saveSubs(subs) {
  const tmp = SUBS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ subscriptions: subs }, null, 2), { mode: 0o600 });
  renameSync(tmp, SUBS_FILE);
}
function publicSub(s) {
  return { id: s.id, slack_user_id: s.slack_user_id, vehicle_name: s.vehicle_name, vehicle_id: s.vehicle_id, oauth_mode: s.oauth_mode, created_at: s.created_at, last_check_at: s.last_check_at };
}

// Wake an asleep vehicle and poll until it reports online. Returns
// true on success, false on timeout. Caller should retry vehicle_data
// only after this returns true. The 60s ceiling matches typical
// Tesla wake latency (model 3 ~30s, model s ~50s); cars deeper in
// hibernation can take longer but the frontend's UX is degraded
// past a minute and it's better to fail loud than block forever.
async function teslaWakeAndPoll(headers, vid) {
  const wakeRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles/${vid}/wake_up`, {
    method: 'POST',
    headers,
  });
  if (!wakeRes.ok) {
    console.error(`[wake] wake_up returned ${wakeRes.status}`);
    return false;
  }
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const stateRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles/${vid}`, { headers });
    if (!stateRes.ok) continue;
    const v = (await stateRes.json()).response;
    console.log(`[wake] poll ${i + 1}/12 — state=${v?.state}`);
    if (v?.state === 'online') return true;
  }
  return false;
}

async function teslaTokenExchange(params) {
  const r = await fetchWithTimeout(TESLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    // Log only the documented error fields — the full body could
    // include the refresh_token in error responses for some grant
    // types, and ec2-user logs are readable to anyone with shell.
    console.error('Tesla token error:', { error: body.error, description: body.error_description });
    throw new Error(body.error_description || body.error || 'Token exchange failed');
  }
  return r.json();
}

function buildRefreshParams(oauth_mode, refresh_token, client_id) {
  const id = oauth_mode === 'app' ? TESLA_APP_CLIENT_ID : client_id;
  return { grant_type: 'refresh_token', client_id: id, refresh_token };
}

// Fetch vehicle_data with location + charge_state. Wakes the car if it
// returns 408 (asleep) and retries once. Throws on anything that
// doesn't parse to a usable response.
async function fetchVehicleData(headers, vid) {
  const url = `${TESLA_BASE}/api/1/vehicles/${vid}/vehicle_data?${VEHICLE_DATA_QS}`;
  let res = await fetchWithTimeout(url, { headers });
  if (res.status === 408) {
    console.log(`[wake] vehicle ${vid} asleep — sending wake_up`);
    if (!await teslaWakeAndPoll(headers, vid)) throw new Error('Vehicle did not wake within 60s');
    res = await fetchWithTimeout(url, { headers });
  }
  if (!res.ok) throw new Error(`vehicle_data ${res.status}`);
  return res.json();
}

async function reverseGeocodeLocation(lat, lng) {
  const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 18, addressdetails: 1 });
  const res = await nominatimFetch(`${NOMINATIM_BASE}/reverse?${params}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  const a = data.address || {};
  return {
    street: a.road || '',
    house_number: a.house_number || '',
    city: a.city || a.town || a.village || '',
    state: a.state || '',
    display_name: data.display_name || '',
  };
}

async function runSweepCheck({ address, today_date, past_noon = false }) {
  const todayStr = today_date || new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T12:00:00Z');
  const future = new Date(today); future.setDate(future.getDate() + 30);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const suggestRes = await fetchWithTimeout(
    `${RECOLLECT_BASE}/areas/Somerville/services/${RECOLLECT_SERVICE}/address-suggest?${new URLSearchParams({ q: address, locale: 'en-US' })}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!suggestRes.ok) throw new Error(`Recollect address suggest ${suggestRes.status}`);
  const suggestions = await suggestRes.json();
  if (!suggestions.length) return { found: false, message: 'Address not found in Somerville sweeping database' };
  const place = suggestions[0];

  const eventsRes = await fetchWithTimeout(
    `${RECOLLECT_BASE}/places/${place.place_id}/services/${RECOLLECT_SERVICE}/events?${new URLSearchParams({ after: todayStr, before: future.toISOString().slice(0, 10), locale: 'en-US' })}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!eventsRes.ok) throw new Error(`Recollect events ${eventsRes.status}`);
  const eventsData = await eventsRes.json();
  const rawEvents = Array.isArray(eventsData) ? eventsData : (eventsData.events || []);

  const sweepEvents = [];
  for (const event of rawEvents) {
    if (!event.flags || !event.day) continue;
    for (const flag of event.flags) {
      const name = flag.name || '';
      if (!name.toLowerCase().includes('sweeping')) continue;
      const m = name.match(/(\d{1,2})(AM|PM)_(\d{1,2})(AM|PM)/);
      sweepEvents.push({
        date: event.day,
        type: name,
        side: name.includes('EVEN') ? 'even' : name.includes('ODD') ? 'odd' : 'both',
        time: m ? `${m[1]}:00 ${m[2]} - ${m[3]}:00 ${m[4]}` : name,
      });
    }
  }

  const houseMatch = address.trim().match(/^(\d+)/);
  const houseNum = houseMatch ? parseInt(houseMatch[1]) : null;
  const carSide = houseNum ? (houseNum % 2 === 0 ? 'even' : 'odd') : null;

  const sweepingToday = sweepEvents.filter(e => e.date === todayStr);
  const sweepingTomorrow = sweepEvents.filter(e => e.date === tomorrowStr);
  const daysUntilNext = sweepEvents.length
    ? Math.max(0, Math.ceil((new Date(sweepEvents[0].date) - new Date(todayStr)) / 86400000))
    : null;

  const sideLabel = (events) => [...new Set(events.map(e => e.side + ' side'))].join(', ');
  const carMatches = (events) => !carSide || events.some(e => e.side === carSide);

  let status, title, message;
  if (sweepingToday.length) {
    const sides = sideLabel(sweepingToday);
    if (past_noon) {
      status = 'info'; title = 'Sweeping Done for Today';
      message = `Sweeping was scheduled today (${sides}, 8AM-12PM). It's past noon — you're clear.`;
    } else if (carMatches(sweepingToday)) {
      status = 'danger'; title = 'MOVE YOUR CAR';
      message = `Sweeping TODAY on YOUR side (${sides}, 8AM-12PM). $50 fine!`;
    } else {
      status = 'warning'; title = 'Sweeping Today — Other Side';
      message = `Sweeping today but on the ${sides} (you're on the ${carSide} side at #${houseNum}).`;
    }
  } else if (sweepingTomorrow.length) {
    const sides = sideLabel(sweepingTomorrow);
    if (carMatches(sweepingTomorrow)) {
      status = 'warning'; title = 'Sweeping Tomorrow — YOUR Side';
      message = `Sweeping TOMORROW on your side (${sides}, 8AM-12PM). Move tonight.`;
    } else {
      status = 'info'; title = 'Sweeping Tomorrow — Other Side';
      message = `Sweeping tomorrow but on the ${sides}. You're on the ${carSide} side at #${houseNum}.`;
    }
  } else if (sweepEvents.length) {
    const e = sweepEvents[0];
    status = 'safe'; title = "You're Good";
    message = `Next sweep in ${daysUntilNext} day${daysUntilNext !== 1 ? 's' : ''}: ${e.date} (${e.side} side, ${e.time})`;
  } else {
    status = 'safe'; title = 'No Sweeping Scheduled';
    message = 'No sweeping events found in the next 30 days.';
  }

  // Forward-geocode the matched address for the map. Best-effort —
  // sweep result still returns even if the geocode fails.
  let latitude = null, longitude = null;
  try {
    const geoRes = await nominatimFetch(
      `${NOMINATIM_BASE}/search?${new URLSearchParams({ q: (place.name || address) + ', Somerville, MA', format: 'jsonv2', limit: 1 })}`,
      { headers: { 'User-Agent': UA } }
    );
    if (geoRes.ok) {
      const results = await geoRes.json();
      if (results.length) { latitude = parseFloat(results[0].lat); longitude = parseFloat(results[0].lon); }
    }
  } catch {}

  return {
    found: true,
    place_name: place.name || address,
    place_id: place.place_id,
    status, title, message,
    sweep_events: sweepEvents,
    car_side: carSide,
    house_num: houseNum,
    days_until_next: daysUntilNext,
    latitude,
    longitude,
  };
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
  res.json({
    vehicles: vehicles.map(v => ({ id: v.id, name: v.display_name || 'Unknown', vin: v.vin, state: v.state })),
  });
}));

// Get location for a specific vehicle
app.post('/api/check', wrap(async (req, res) => {
  const { token, vehicle_id } = req.body;
  if (!token) return res.status(400).json({ detail: 'Token required' });

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

app.post('/api/sweep-check', wrap(async (req, res) => {
  const { address, today_date, past_noon } = req.body;
  if (!address) return res.status(400).json({ detail: 'Address required' });
  res.json(await runSweepCheck({ address, today_date, past_noon }));
}));

// Pre-configured app OAuth — credentials stay server-side
app.post('/api/oauth/app/start', (req, res) => {
  if (!TESLA_APP_CLIENT_ID) return res.status(500).json({ detail: 'App OAuth not configured' });
  const state = randomBytes(32).toString('base64url');
  const scope = 'openid offline_access vehicle_device_data vehicle_location';
  const params = new URLSearchParams({ response_type: 'code', client_id: TESLA_APP_CLIENT_ID, redirect_uri: TESLA_APP_REDIRECT_URI, scope, state, prompt: 'login', prompt_missing_scopes: 'true', locale: 'en-US' });
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

// Custom OAuth — user provides their own credentials
app.post('/api/oauth/start', wrap(async (req, res) => {
  const { client_id, client_secret, redirect_uri, register = false, scope = 'openid offline_access vehicle_device_data vehicle_location' } = req.body;

  if (register) {
    try {
      const partnerToken = await teslaTokenExchange({
        grant_type: 'client_credentials', client_id, client_secret,
        scope: 'openid vehicle_device_data vehicle_location',
        audience: TESLA_BASE,
      });
      await fetchWithTimeout(`${TESLA_BASE}/api/1/partner_accounts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${partnerToken.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'claw.bitvox.me' }),
      });
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error('Partner registration failed:', e.message);
    }
  }

  const state = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri, scope, state, prompt: 'login', locale: 'en-US' });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
}));

app.post('/api/oauth/callback', wrap(async (req, res) => {
  const { client_id, client_secret, redirect_uri, code } = req.body;
  const data = await teslaTokenExchange({
    grant_type: 'authorization_code', client_id, client_secret, code, redirect_uri,
    audience: TESLA_BASE,
  });
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, token_type: data.token_type });
}));

app.post('/api/oauth/refresh', wrap(async (req, res) => {
  const { client_id, refresh_token } = req.body;
  const data = await teslaTokenExchange({ grant_type: 'refresh_token', client_id, refresh_token });
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
  });
}));

// Daily-notification subscription endpoints. Stores the user's Tesla
// refresh_token server-side so a 12pm ET cron can wake the car, check
// the sweeping schedule, and DM via Slack on T-3/T-2/T-1.
app.post('/api/notifications/enable', wrap(async (req, res) => {
  const { refresh_token, oauth_mode = 'app', client_id, vehicle_id, vehicle_name, slack_user_id } = req.body;
  if (!refresh_token || !slack_user_id || !vehicle_id) {
    return res.status(400).json({ detail: 'refresh_token, slack_user_id, and vehicle_id are required' });
  }
  if (oauth_mode === 'custom' && !client_id) {
    return res.status(400).json({ detail: 'custom oauth requires client_id' });
  }
  if (!SLACK_USER_ID_RE.test(slack_user_id)) {
    return res.status(400).json({ detail: 'slack_user_id should look like U060NLFUM' });
  }
  // Validate the refresh_token by doing one round-trip. Catches typos
  // and revoked tokens before we persist garbage.
  let rotated;
  try {
    rotated = await teslaTokenExchange(buildRefreshParams(oauth_mode, refresh_token, client_id));
  } catch (e) {
    return res.status(400).json({ detail: 'Refresh token invalid: ' + e.message });
  }
  const subs = loadSubs();
  // One subscription per (slack_user_id, vehicle_id) — re-enable replaces.
  const filtered = subs.filter(s => !(s.slack_user_id === slack_user_id && s.vehicle_id === vehicle_id));
  const sub = {
    id: randomBytes(8).toString('hex'),
    slack_user_id,
    vehicle_id,
    vehicle_name: vehicle_name || 'Unknown',
    oauth_mode,
    client_id: oauth_mode === 'custom' ? client_id : null,
    refresh_token: rotated.refresh_token || refresh_token,
    created_at: new Date().toISOString(),
    last_check_at: null,
  };
  filtered.push(sub);
  saveSubs(filtered);
  res.json({ enabled: true, id: sub.id });
}));

app.post('/api/notifications/disable', wrap(async (req, res) => {
  const { id, slack_user_id } = req.body;
  if (!id || !slack_user_id) return res.status(400).json({ detail: 'id and slack_user_id required' });
  const subs = loadSubs();
  const before = subs.length;
  // slack_user_id must match — prevents one user from disabling another's sub by guessing the id.
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

// Cron-callable: refresh each subscription's tokens, fetch + sweep-check,
// return all results. Caller (tinyclaw scheduler) decides who to DM.
// Cron fires at noon ET so past_noon is always false here — the
// notifier filters days_until_next ∈ {1,2,3} anyway, never sweep-day.
function bearerOk(authHeader, token) {
  if (!token) return false;
  const expected = `Bearer ${token}`;
  if (authHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

app.post('/api/notifications/run', wrap(async (req, res) => {
  if (!bearerOk(req.get('authorization') || '', NOTIFICATIONS_RUN_TOKEN)) {
    return res.status(401).json({ detail: 'Unauthorized' });
  }
  const subs = loadSubs();
  const results = [];
  for (const sub of subs) {
    const out = { sub_id: sub.id, slack_user_id: sub.slack_user_id, vehicle_id: sub.vehicle_id, vehicle_name: sub.vehicle_name };
    try {
      const rotated = await teslaTokenExchange(buildRefreshParams(sub.oauth_mode, sub.refresh_token, sub.client_id));
      // Tesla rotates refresh_tokens — persist the new one immediately
      // so a later iteration crash doesn't lose it (next run's stale
      // token would 401 and brick the sub).
      if (rotated.refresh_token && rotated.refresh_token !== sub.refresh_token) {
        sub.refresh_token = rotated.refresh_token;
        saveSubs(subs);
      }
      const headers = { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' };

      const locData = await fetchVehicleData(headers, sub.vehicle_id);
      const { latitude, longitude } = locData.response?.drive_state || {};
      if (latitude == null || longitude == null) throw new Error('No vehicle location');
      out.battery_level = locData.response?.charge_state?.battery_level ?? null;

      const geo = await reverseGeocodeLocation(latitude, longitude);
      const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
      out.address = geo.display_name || addr;
      if (!addr) throw new Error('No street resolved from coordinates');

      const sweep = await runSweepCheck({ address: addr, today_date: new Date().toISOString().slice(0, 10) });
      out.found = !!sweep.found;
      out.days_until_next = sweep.days_until_next ?? null;
      out.status = sweep.status || null;
      out.title = sweep.title || null;
      out.message = sweep.message || null;
      out.car_side = sweep.car_side || null;
      out.next_event = sweep.sweep_events?.[0] || null;
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    sub.last_check_at = new Date().toISOString();
    sub.last_result = { ok: out.ok, days_until_next: out.days_until_next, error: out.error };
    results.push(out);
  }
  if (subs.length) saveSubs(subs);
  res.json({ ran_at: new Date().toISOString(), results });
}));

// API 404 catch — must be before the SPA catch-all
app.all('/api/*', (req, res) => res.status(404).json({ detail: 'API endpoint not found' }));

app.use(express.static(join(__dirname, 'dist')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')));

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const PORT = process.env.PORT || 20040;
app.listen(PORT, '127.0.0.1', () => console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`));

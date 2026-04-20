import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const RECOLLECT_BASE = 'https://api.recollect.net/api';
const RECOLLECT_SERVICE = 349;
const UA = 'TeslaSweeper/1.0';
const FETCH_TIMEOUT = 12000;

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

async function teslaTokenExchange(params) {
  const r = await fetchWithTimeout(TESLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    console.error('Tesla token error:', body);
    throw new Error(body.error_description || body.error || 'Token exchange failed');
  }
  return r.json();
}

app.post('/api/check', wrap(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ detail: 'Token required' });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const vehiclesRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles`, { headers });
  if (vehiclesRes.status === 401) return res.status(401).json({ detail: 'Invalid or expired Tesla token' });
  if (!vehiclesRes.ok) return res.status(vehiclesRes.status).json({ detail: 'Tesla API error' });

  const vehicles = (await vehiclesRes.json()).response || [];
  if (!vehicles.length) return res.status(404).json({ detail: 'No vehicles found on this account' });

  const vehicle = vehicles[0];
  const locRes = await fetchWithTimeout(
    `${TESLA_BASE}/api/1/vehicles/${vehicle.id}/vehicle_data?endpoints=location_data`,
    { headers }
  );
  if (locRes.status === 408) return res.status(408).json({ detail: 'Vehicle is asleep. Open the Tesla app to wake it, then retry.' });
  if (!locRes.ok) return res.status(locRes.status).json({ detail: 'Failed to get vehicle data' });

  const driveState = (await locRes.json()).response?.drive_state || {};
  const { latitude, longitude } = driveState;
  if (latitude == null || longitude == null) return res.status(404).json({ detail: 'Could not determine vehicle location' });

  res.json({ vehicle_name: vehicle.display_name || 'Unknown', latitude, longitude });
}));

app.post('/api/reverse-geocode', wrap(async (req, res) => {
  const { lat, lng } = req.body;
  const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 18, addressdetails: 1 });
  const geoRes = await nominatimFetch(`${NOMINATIM_BASE}/reverse?${params}`, { headers: { 'User-Agent': UA } });
  if (!geoRes.ok) return res.status(502).json({ detail: 'Nominatim returned an error' });

  const data = await geoRes.json();
  const address = data.address || {};
  res.json({
    street: address.road || '',
    house_number: address.house_number || '',
    city: address.city || address.town || address.village || '',
    state: address.state || '',
    display_name: data.display_name || '',
  });
}));

app.post('/api/sweep-check', wrap(async (req, res) => {
  const { address, today_date } = req.body;
  if (!address) return res.status(400).json({ detail: 'Address required' });

  const todayStr = today_date || new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T12:00:00Z');
  const future = new Date(today);
  future.setDate(future.getDate() + 30);
  const tomorrowDate = new Date(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  const suggestParams = new URLSearchParams({ q: address, locale: 'en-US' });
  const suggestRes = await fetchWithTimeout(
    `${RECOLLECT_BASE}/areas/Somerville/services/${RECOLLECT_SERVICE}/address-suggest?${suggestParams}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!suggestRes.ok) return res.status(502).json({ detail: 'Recollect address suggest error' });

  const suggestions = await suggestRes.json();
  if (!suggestions.length) return res.json({ found: false, message: 'Address not found in Somerville sweeping database' });

  const place = suggestions[0];

  const eventsParams = new URLSearchParams({ after: todayStr, before: future.toISOString().slice(0, 10), locale: 'en-US' });
  const eventsRes = await fetchWithTimeout(
    `${RECOLLECT_BASE}/places/${place.place_id}/services/${RECOLLECT_SERVICE}/events?${eventsParams}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!eventsRes.ok) return res.status(502).json({ detail: 'Recollect events error' });

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
    const pastNoon = req.body.past_noon || false;
    if (pastNoon) {
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

  // Forward geocode the matched address for map display
  let latitude = null, longitude = null;
  try {
    const geoParams = new URLSearchParams({ q: (place.name || address) + ', Somerville, MA', format: 'jsonv2', limit: 1 });
    const geoRes = await nominatimFetch(`${NOMINATIM_BASE}/search?${geoParams}`, { headers: { 'User-Agent': UA } });
    if (geoRes.ok) {
      const results = await geoRes.json();
      if (results.length) {
        latitude = parseFloat(results[0].lat);
        longitude = parseFloat(results[0].lon);
      }
    }
  } catch {}

  res.json({
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
  });
}));

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

// API 404 catch — must be before the SPA catch-all
app.all('/api/*', (req, res) => res.status(404).json({ detail: 'API endpoint not found' }));

app.use(express.static(join(__dirname, 'dist')));
app.get('*', (req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')));

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

const PORT = process.env.PORT || 20040;
app.listen(PORT, '127.0.0.1', () => console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`));

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'fs';
import cron from 'node-cron';
import { classifyWeek, shouldDispatchPlan, formatPlanDM, formatWeeklyDigest } from './notifications/planner.js';
import { wrap } from './middleware/errors.js';
import { brotliMiddleware } from './middleware/brotli.js';
import { signSession, verifySession } from './crypto/session.js';
import { bearerOk } from './crypto/bearer.js';
import { loadStore, saveStore, loadSubs, saveSubs, publicSub, patchSub } from './store/subscriptions.js';

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
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const RECOLLECT_BASE = 'https://api.recollect.net/api';
const RECOLLECT_SERVICE = 349;
const UA = 'TeslaSweeper/1.0';
const FETCH_TIMEOUT = 12000;
const VEHICLE_DATA_QS = 'endpoints=location_data%3Bcharge_state';
const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

// Stub test vehicle — env-flag-gated mock used when the Tesla API
// returns no vehicles. Lets developers / VoX exercise the full app
// flow (vehicles list → check car → enable notifications → cron DM)
// without owning a real Tesla. See docs/stub-vehicle-plan.md.
const STUB_VEHICLE_ENABLED = process.env.STUB_VEHICLE_ENABLED === '1';
const STUB_VEHICLE_ID = 999999999999999;          // 15 digits — real Tesla IDs are 16
const STUB_VEHICLE_VIN = 'STUBTEST00000000000';
const STUB_VEHICLE_LAT = parseFloat(process.env.STUB_VEHICLE_LAT) || 42.385081;
const STUB_VEHICLE_LNG = parseFloat(process.env.STUB_VEHICLE_LNG) || -71.107841;
const STUB_VEHICLE_NAME = process.env.STUB_VEHICLE_NAME || 'Test Vehicle';
const STUB_REFRESH_TOKEN = 'STUB_REFRESH_TOKEN';   // sentinel persisted in subscriptions.json; cron branches on it
function isStubVehicle(id) { return STUB_VEHICLE_ENABLED && String(id) === String(STUB_VEHICLE_ID); }

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

const NOTIFICATIONS_RUN_TOKEN = process.env.NOTIFICATIONS_RUN_TOKEN || '';
const STUCK_FAIL_THRESHOLD = 3;
const STUCK_DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

// Post a Slack DM via chat.postMessage. mrkdwn:false defangs any
// `<...>`/`*...*` chars that slipped in from user-supplied vehicle
// names or Nominatim address strings — DMs render plain text.
async function postSlackDM(slack_user_id, text) {
  if (!SLACK_BOT_TOKEN) return { ok: false, error: 'SLACK_BOT_TOKEN not configured' };
  const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: slack_user_id, text, mrkdwn: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error('[slack-dm] postMessage failed:', data.error);
  return { ok: !!data.ok, error: data.error };
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

async function runSweepCheck({ address, today_date, past_noon = false, lat, lng }) {
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
  const parsedHouseNum = houseMatch ? parseInt(houseMatch[1]) : null;

  // OSM-based geometric detection beats houseNum%2 when a car parks
  // across from its own address. Fall back to parity if OSM lacks
  // building data on the street or the lookup throws.
  let carSide = null;
  let sideSource = null;
  let sideDetection = null;
  try {
    sideDetection = await whichSide(lat, lng);
    if (sideDetection.side === 'odd' || sideDetection.side === 'even') {
      carSide = sideDetection.side;
      sideSource = 'osm';
    }
  } catch (e) {
    console.warn('[sweep-check] whichSide threw:', e.message);
  }
  if (!carSide && parsedHouseNum) {
    carSide = parsedHouseNum % 2 === 0 ? 'even' : 'odd';
    sideSource = 'house_parity';
    // [fallback] in journalctl = OSM no-data path engaged; grep this
    // to gauge how often the parity heuristic is carrying the result.
    console.warn(`[sweep-check] [fallback] OSM no-data, using parity for #${parsedHouseNum} → ${carSide}`);
  }
  // Canonical house number for display: prefer the OSM-detected
  // car-side number (the actual house on the car's curb); fall back
  // to the address-parsed one when OSM has no data. Used by both the
  // server-side message templates and the SPA's Details card so they
  // never disagree.
  const houseNum = sideDetection?.car_house_number ?? parsedHouseNum;

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

  return {
    found: true,
    place_name: place.name || address,
    place_id: place.place_id,
    status, title, message,
    sweep_events: sweepEvents,
    car_side: carSide,
    side_source: sideSource,
    side_detection: sideDetection,
    house_num: houseNum,
    days_until_next: daysUntilNext,
    latitude: lat,
    longitude: lng,
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

// whichSide(lat, lng) — geometric "which curb" detection.
// Picks the closest named drivable highway segment to the pin, takes the
// 2D cross-product sign to know which side of A→B the pin is on, then
// queries OSM buildings tagged addr:street=<road> and tallies even-vs-
// odd house numbers per side to map cross sign → odd/even parity.
// Beats houseNum%2 when a car parks across from its own address.
async function whichSide(lat, lng) {
  // Filter to *named* drivable highways — sidewalks/footpaths digitized
  // parallel to the real street would otherwise win the closest-segment
  // race when the pin is near a curb.
  const drivableHighways = '^(residential|primary|secondary|tertiary|unclassified|living_street|trunk|motorway|primary_link|secondary_link|tertiary_link|trunk_link|motorway_link)$';
  const namedQ = `[out:json][timeout:10];way(around:50,${lat},${lng})[highway~"${drivableHighways}"][name];out geom;`;

  const overpass = (q) => fetchWithTimeout(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } });
  const r0 = await overpass(namedQ);
  if (!r0.ok) throw new Error(`Overpass ${r0.status}`);
  const ways = ((await r0.json()).elements || []).filter(e => e.type === 'way' && e.geometry?.length >= 2);
  if (!ways.length) return { side: 'unknown', error: 'no nearby roads in OSM' };

  // Overpass `out geom` returns {lat, lon} — inline the rename to lng.
  let best = null;
  for (const way of ways) {
    const geom = way.geometry.map(n => ({ lat: n.lat, lng: n.lon }));
    for (let i = 0; i < geom.length - 1; i++) {
      const A = geom[i], B = geom[i + 1];
      const r = projectPointToSegment({ lat, lng }, A, B);
      if (!best || r.dist < best.dist) best = { way, A, B, ...r };
    }
  }
  if (!best) return { side: 'unknown', error: 'no segments' };

  const cross = crossSign(best.A, best.B, { lat, lng });
  const offsetM = haversineMeters(lat, lng, best.foot.lat, best.foot.lng);

  // Buildings on this street within ~80m of the foot. Nominatim reverse-
  // geocode isn't dense enough to distinguish curbs (both perpendicular
  // probes can return the same near-side house number), so we go to OSM.
  const wayName = best.way.tags?.name || '';
  let buildings = [];
  if (wayName) {
    // OSM names are public-edit data — escape \ first, then ", then
    // strip control chars so a malformed way name can't break out of
    // the Overpass string literal.
    const escName = wayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
    const bq = `[out:json][timeout:10];(way(around:80,${best.foot.lat},${best.foot.lng})["building"]["addr:street"="${escName}"];node(around:80,${best.foot.lat},${best.foot.lng})["addr:housenumber"]["addr:street"="${escName}"];);out tags center;`;
    try {
      const r = await overpass(bq);
      if (r.ok) {
        const j = await r.json();
        for (const e of j.elements || []) {
          const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
          const hn = e.tags?.['addr:housenumber'];
          if (!c || !hn) continue;
          const m = String(hn).match(/(\d+)/);
          if (!m) continue;
          buildings.push({ num: parseInt(m[1], 10), lat: c.lat, lng: c.lon });
        }
      }
    } catch {}
  }

  let leftEven = 0, leftOdd = 0, rightEven = 0, rightOdd = 0;
  let leftBuildings = [], rightBuildings = [];
  for (const b of buildings) {
    const s = crossSign(best.A, best.B, b);
    if (s > 0) {
      leftBuildings.push(b);
      if (b.num % 2 === 0) leftEven++; else leftOdd++;
    } else if (s < 0) {
      rightBuildings.push(b);
      if (b.num % 2 === 0) rightEven++; else rightOdd++;
    }
  }
  // Vote-count which hypothesis fits the buildings observed: "left of
  // A→B is the even curb" gets one vote per left-even and one per right-
  // odd; the inverse hypothesis gets the mirror. Handles single-side-
  // data and corner-lot mixed addressing in one expression. Tie → null.
  const leftIsEven = leftEven + rightOdd;
  const leftIsOdd = leftOdd + rightEven;
  const evenSideSign = leftIsEven > leftIsOdd ? +1 : leftIsOdd > leftIsEven ? -1 : null;

  let side = 'unknown';
  if (evenSideSign != null && cross !== 0) {
    side = (cross === evenSideSign) ? 'even' : 'odd';
  }

  // Closest building on each side — for response display.
  const f = best.foot;
  function nearestOf(arr) {
    let bb = null, bd = Infinity;
    for (const b of arr) {
      const d = haversineMeters(f.lat, f.lng, b.lat, b.lng);
      if (d < bd) { bd = d; bb = b; }
    }
    return bb ? bb.num : null;
  }
  const leftRep = nearestOf(leftBuildings);
  const rightRep = nearestOf(rightBuildings);
  const carNum = cross > 0 ? leftRep : cross < 0 ? rightRep : null;
  const oppositeNum = cross > 0 ? rightRep : cross < 0 ? leftRep : null;

  return {
    side,
    road_name: best.way.tags?.name || best.way.tags?.ref || 'unknown',
    perpendicular_offset_m: Math.round(offsetM * 10) / 10,
    cross_sign: cross,
    car_house_number: carNum,
    opposite_house_number: oppositeNum,
    buildings_seen: buildings.length,
    side_parity: { left_even: leftEven, left_odd: leftOdd, right_even: rightEven, right_odd: rightOdd },
    even_side: evenSideSign === +1 ? 'left of A→B' : evenSideSign === -1 ? 'right of A→B' : 'unknown',
    way_id: best.way.id,
    segment: { A: best.A, B: best.B, t: best.t, foot: best.foot },
  };
}

// Project P onto segment AB (lat/lng treated as planar — fine at street scale).
// Returns { dist, t (clamped 0..1), foot (the projection point) }.
function projectPointToSegment(P, A, B) {
  const dx = B.lng - A.lng, dy = B.lat - A.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return { dist: Math.hypot(P.lng - A.lng, P.lat - A.lat), t: 0, foot: { lat: A.lat, lng: A.lng } };
  }
  let t = ((P.lng - A.lng) * dx + (P.lat - A.lat) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const fx = A.lng + dx * t, fy = A.lat + dy * t;
  return { dist: Math.hypot(P.lng - fx, P.lat - fy), t, foot: { lat: fy, lng: fx } };
}

function crossSign(A, B, P) {
  const dx = B.lng - A.lng, dy = B.lat - A.lat;
  const px = P.lng - A.lng, py = P.lat - A.lat;
  const c = dx * py - dy * px;
  return c > 0 ? 1 : c < 0 ? -1 : 0;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

// Build the per-sub plan (class + windowEvents + primaryEvent) using
// the same classifier the message formatters consume. Returns null
// when the sweep lookup itself failed so callers don't try to DM.
function buildPlan(out, todayET) {
  if (!out.ok || !out.found) return null;
  return classifyWeek({
    events: out.sweep_events || [],
    carSide: out.car_side,
    sideDetection: out.side_detection,
    todayET,
  });
}

// Single-flight guard. Both the in-process cron and the HTTP /run
// endpoint call runNotifications; without this, two concurrent loads
// would fight on the rotated refresh_token rename and brick a sub.
let runningNotifications = null;
let runningMode = null;
async function runNotifications({ mode = 'daily' } = {}) {
  if (mode !== 'daily' && mode !== 'weekly') {
    throw new Error(`runNotifications: invalid mode '${mode}'`);
  }
  if (runningNotifications) {
    if (runningMode === mode) return runningNotifications;
    // Different mode in flight — refuse rather than return the wrong-mode
    // promise. Crons + manual /run surface the error in their handlers.
    throw new Error(`runNotifications: another run already in flight (mode='${runningMode}')`);
  }
  runningMode = mode;
  runningNotifications = (async () => {
    const subs = loadStore().subscriptions || [];
    const results = [];
    const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

    for (const sub of subs) {
      const out = { sub_id: sub.id, slack_user_id: sub.slack_user_id, vehicle_id: sub.vehicle_id, vehicle_name: sub.vehicle_name };
      try {
        let latitude, longitude;
        if (STUB_VEHICLE_ENABLED && sub.refresh_token === STUB_REFRESH_TOKEN) {
          // Stub: skip Tesla token refresh + vehicle_data wake-and-poll.
          // Reverse-geocode + Recollect + Slack DM still run for real.
          latitude = STUB_VEHICLE_LAT;
          longitude = STUB_VEHICLE_LNG;
          out.battery_level = 78;
        } else {
          const rotated = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token: sub.refresh_token });
          // Tesla rotates refresh_tokens on each exchange; persist
          // immediately so a crash later in the loop doesn't leave us
          // with a now-revoked token next run.
          if (rotated.refresh_token && rotated.refresh_token !== sub.refresh_token) {
            patchSub(sub.id, { refresh_token: rotated.refresh_token });
          }
          const headers = { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' };

          const locData = await fetchVehicleData(headers, sub.vehicle_id);
          ({ latitude, longitude } = locData.response?.drive_state || {});
          out.battery_level = locData.response?.charge_state?.battery_level ?? null;
        }
        if (latitude == null || longitude == null) throw new Error('No vehicle location');

        const geo = await reverseGeocodeLocation(latitude, longitude);
        const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
        out.address = geo.display_name || addr;
        if (!addr) throw new Error('No street resolved from coordinates');

        const sweep = await runSweepCheck({
          address: addr,
          today_date: todayET,
          lat: latitude,
          lng: longitude,
        });
        out.found = !!sweep.found;
        out.days_until_next = sweep.days_until_next ?? null;
        out.status = sweep.status || null;
        out.title = sweep.title || null;
        out.message = sweep.message || null;
        out.car_side = sweep.car_side || null;
        out.sweep_events = sweep.sweep_events || [];
        out.side_detection = sweep.side_detection || null;
        // Canonicalize on the OSM-detected car-side house number — the
        // reverse-geocode often returns the closest building (which can
        // be on the opposite curb, especially for oversized lots) and
        // we don't want the DM to name a house that isn't the user's.
        const carHouseNum = sweep.side_detection?.car_house_number;
        if (carHouseNum && geo.street) {
          out.address = geo.city ? `${carHouseNum} ${geo.street}, ${geo.city}` : `${carHouseNum} ${geo.street}`;
        }
        out.ok = true;
      } catch (e) {
        out.ok = false;
        out.error = e.message;
      }
      // Track consecutive_failures so we can DM the user once their
      // sub stops working (Tesla token revoked, vehicle removed, etc).
      out.consecutive_failures = out.ok ? 0 : (sub.consecutive_failures || 0) + 1;
      patchSub(sub.id, {
        last_check_at: new Date().toISOString(),
        last_result: { ok: out.ok, days_until_next: out.days_until_next, error: out.error },
        consecutive_failures: out.consecutive_failures,
      });
      out.last_dm_error_at = sub.last_dm_error_at || null;
      out.last_dm_date = sub.last_dm_date || null;
      out.last_digest_date = sub.last_digest_date || null;
      out.plan = buildPlan(out, todayET);
      results.push(out);
    }
    // Daily dispatch: per-sub plan classifier picks one of N action
    // classes; only fire when class != safe AND the soonest event is
    // 1-3 days out. last_dm_date dedupes across same-day re-runs
    // (cron + manual /run + missed-run recovery on restart).
    if (mode === 'daily') {
      for (const out of results) {
        if (!out.plan || !shouldDispatchPlan(out.plan)) continue;
        if (out.last_dm_date === todayET) { out.dm_skipped = 'already-sent-today'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatPlanDM({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan }));
        out.dm_sent = dm.ok;
        out.dm_error = dm.error || null;
        if (dm.ok) patchSub(out.sub_id, { last_dm_date: todayET });
      }
    } else if (mode === 'weekly') {
      // Sunday-evening digest: full schedule + recommendation, every
      // sub regardless of imminence. Separate dedup field so the daily
      // and weekly cadences don't suppress each other when both fire
      // the same Sunday.
      for (const out of results) {
        if (!out.plan) continue;
        if (out.last_digest_date === todayET) { out.digest_skipped = 'already-sent-today'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatWeeklyDigest({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan }));
        out.digest_sent = dm.ok;
        out.digest_error = dm.error || null;
        if (dm.ok) patchSub(out.sub_id, { last_digest_date: todayET });
      }
    }
    // Stuck-sub notice: DM once the failure count crosses the threshold,
    // then once per day while it stays stuck. Daily-mode only so a Sunday
    // 8PM digest doesn't double-DM a sub whose token is dead.
    if (mode === 'daily') {
      for (const out of results) {
        if (out.ok || out.consecutive_failures < STUCK_FAIL_THRESHOLD) continue;
        const lastErrTs = out.last_dm_error_at ? Date.parse(out.last_dm_error_at) : 0;
        if (Date.now() - lastErrTs < STUCK_DM_COOLDOWN_MS) continue;
        const dm = await postSlackDM(out.slack_user_id,
          `:warning: *${out.vehicle_name}* sweeper notifications have been failing for ${out.consecutive_failures} runs. Last error: \`${out.error}\`. Re-enable at <https://claw.bitvox.me/sweeper/>.`);
        out.error_dm_sent = dm.ok;
        if (dm.ok) patchSub(out.sub_id, { last_dm_error_at: new Date().toISOString() });
      }
    }
    // Only mark "ran today" if at least one sub processed successfully.
    // A total-outage day shouldn't suppress tomorrow's missed-run recovery.
    if (results.some(r => r.ok)) {
      const store = loadStore();
      if (mode === 'daily') store.last_run_at = new Date().toISOString();
      else store.last_digest_run_at = new Date().toISOString();
      saveStore(store);
    }
    return { ran_at: new Date().toISOString(), mode, results };
  })().finally(() => { runningNotifications = null; runningMode = null; });
  return runningNotifications;
}

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

// Daily noon-ET notification cron + Sunday-evening digest. node-cron
// handles DST via the timezone string, so the calendar expressions
// stay identical year-round.
function startNotificationCron() {
  cron.schedule('0 12 * * *', async () => {
    console.log('[cron] firing daily notification run');
    try {
      const r = await runNotifications({ mode: 'daily' });
      const errs = r.results.filter(o => !o.ok);
      const dmFails = r.results.filter(o => o.dm_sent === false && o.plan && shouldDispatchPlan(o.plan));
      const dmsOk = r.results.filter(o => o.dm_sent).length;
      const dmsDup = r.results.filter(o => o.dm_skipped).length;
      const dmsStuck = r.results.filter(o => o.error_dm_sent).length;
      console.log(`[cron] subs=${r.results.length} dm_sent=${dmsOk} dm_dup=${dmsDup} dm_stuck=${dmsStuck} errs=${errs.length} dm_fails=${dmFails.length}`);
      for (const o of errs) console.warn(`[cron] sub ${o.sub_id} (${o.vehicle_name}) error: ${o.error} (fails=${o.consecutive_failures})`);
      for (const o of dmFails) console.warn(`[cron] sub ${o.sub_id} (${o.vehicle_name}) DM failed: ${o.dm_error}`);
    } catch (e) { console.error('[cron] runNotifications failed:', e); }
  }, { timezone: 'America/New_York' });

  // Weekly digest — Sunday 8PM ET. Always sends (even for empty weeks)
  // so the user gets a Sunday-evening planning view of what's coming.
  cron.schedule('0 20 * * 0', async () => {
    console.log('[cron] firing weekly digest run');
    try {
      const r = await runNotifications({ mode: 'weekly' });
      const errs = r.results.filter(o => !o.ok);
      const sent = r.results.filter(o => o.digest_sent).length;
      const dup = r.results.filter(o => o.digest_skipped).length;
      console.log(`[cron] digest subs=${r.results.length} sent=${sent} dup=${dup} errs=${errs.length}`);
      for (const o of errs) console.warn(`[cron] digest sub ${o.sub_id} error: ${o.error}`);
    } catch (e) { console.error('[cron] weekly digest failed:', e); }
  }, { timezone: 'America/New_York' });
}

// On boot, recover a missed run. If we're already past noon ET today
// and the last successful run was on a prior date (in ET), fire once.
// Avoids the failure mode where the service restarts between 12:00pm
// and tomorrow's cron, silently skipping today.
function maybeRecoverMissedRun() {
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const todayET = fmtDate.format(new Date());
  const hourET = parseInt(fmtHour.format(new Date()), 10);
  if (hourET < 12) return;
  const last = loadStore().last_run_at || null;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return;
  console.log(`[cron] recovering missed run (last: ${lastDateET || 'never'}, today: ${todayET})`);
  runNotifications().catch(e => console.error('[cron] missed-run recovery failed:', e));
}

// Symmetric digest recovery: if today is Sunday past 8PM ET and we
// haven't run a digest in this calendar week, fire one. Otherwise a
// boot across Sunday 8PM silently skips that week's digest forever.
function maybeRecoverMissedDigest() {
  const now = new Date();
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmtParts.formatToParts(now).map(p => [p.type, p.value]));
  if (parts.weekday !== 'Sun' || parseInt(parts.hour, 10) < 20) return;
  const todayET = fmtDate.format(now);
  const last = loadStore().last_digest_run_at || null;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return;
  console.log(`[cron] recovering missed digest (last: ${lastDateET || 'never'}, today: ${todayET})`);
  runNotifications({ mode: 'weekly' }).catch(e => console.error('[cron] missed-digest recovery failed:', e));
}

const PORT = process.env.PORT || 20040;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tesla Sweeper on http://127.0.0.1:${PORT}`);
  startNotificationCron();
  maybeRecoverMissedRun();
  maybeRecoverMissedDigest();
});

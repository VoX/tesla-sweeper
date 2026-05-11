// Tesla Fleet API helpers — token exchange, vehicle wake-and-poll, stub config.

import { fetchWithTimeout } from '../util/fetch.js';

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const VEHICLE_DATA_QS = 'endpoints=location_data%3Bcharge_state';

export const STUB_VEHICLE_ENABLED = process.env.STUB_VEHICLE_ENABLED === '1';
export const STUB_VEHICLE_ID = 999999999999999;          // 15 digits — real Tesla IDs are 16
export const STUB_VEHICLE_VIN = 'STUBTEST00000000000';
export const STUB_VEHICLE_LAT = parseFloat(process.env.STUB_VEHICLE_LAT) || 42.385081;
export const STUB_VEHICLE_LNG = parseFloat(process.env.STUB_VEHICLE_LNG) || -71.107841;
export const STUB_VEHICLE_NAME = process.env.STUB_VEHICLE_NAME || 'Test Vehicle';
export const STUB_REFRESH_TOKEN = 'STUB_REFRESH_TOKEN';  // sentinel persisted in subscriptions.json; cron branches on it
export function isStubVehicle(id) {
  return STUB_VEHICLE_ENABLED && String(id) === String(STUB_VEHICLE_ID);
}

// Wake an asleep vehicle and poll until it reports online. Returns true
// on success, false on timeout. The 60s ceiling matches typical Tesla
// wake latency; cars deeper in hibernation can take longer but the UX
// is degraded past a minute and it's better to fail loud than block.
export async function teslaWakeAndPoll(headers, vid) {
  const wakeRes = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles/${vid}/wake_up`, {
    method: 'POST', headers,
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

export async function teslaTokenExchange(params) {
  const r = await fetchWithTimeout(TESLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    // Log only the documented error fields — the full body could include
    // the refresh_token in error responses for some grant types, and
    // ec2-user logs are readable to anyone with shell.
    console.error('Tesla token error:', { error: body.error, description: body.error_description });
    throw new Error(body.error_description || body.error || 'Token exchange failed');
  }
  return r.json();
}

// GET /api/1/vehicles → normalized list: [{ id, name, vin, state }].
// Stringifies v.id at the boundary (Tesla returns 16-digit ints above
// MAX_SAFE_INTEGER; JSON round-tripping loses precision and the SPA
// <select> binds value as a string anyway). Injects the stub vehicle
// when STUB_VEHICLE_ENABLED and the account has none. Throws on a
// non-2xx with `.status` set so the caller can map it (401 → re-auth).
export async function listVehicles(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const res = await fetchWithTimeout(`${TESLA_BASE}/api/1/vehicles`, { headers });
  if (!res.ok) {
    const detail = res.status === 401 ? 'Invalid or expired Tesla token' : `Tesla API error (${res.status})`;
    const err = new Error(detail);
    err.status = res.status;
    if (res.status !== 401) console.error('[vehicles] Tesla API error:', res.status, await res.text().catch(() => ''));
    throw err;
  }
  const vehicles = (await res.json()).response || [];
  const out = vehicles.map(v => ({ id: String(v.id), name: v.display_name || 'Unknown', vin: v.vin, state: v.state }));
  if (STUB_VEHICLE_ENABLED && out.length === 0) {
    out.push({ id: String(STUB_VEHICLE_ID), name: STUB_VEHICLE_NAME, vin: STUB_VEHICLE_VIN, state: 'online', is_stub: true });
  }
  return out;
}

// Fetch vehicle_data with location + charge_state. Wakes the car if it
// returns 408 (asleep) and retries once. Throws on anything that
// doesn't parse to a usable response.
export async function fetchVehicleData(headers, vid) {
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

export { TESLA_BASE };

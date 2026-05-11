// Tesla Fleet API + reverse-geocode proxies for the SPA.
// /api/vehicles lists, /api/check fetches GPS (stub short-circuit +
// wake/poll on 408), /api/reverse-geocode wraps Nominatim.
//
// Auth (BFF, Phase 6): the preferred path is the signed `session`
// cookie — the server then brokers a Tesla access_token via
// getTeslaAccess (which owns refresh-token rotation). A legacy `token`
// body field is still accepted for one release so a stale cached SPA
// keeps working; it'll be removed in Phase 8. Cookie wins if both are
// present.

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import {
  STUB_VEHICLE_LAT, STUB_VEHICLE_LNG, STUB_VEHICLE_NAME,
  isStubVehicle, fetchVehicleData, listVehicles,
} from '../integrations/tesla.js';
import { getTeslaAccess, RevokedError, ConfigError, TransientError } from '../integrations/tesla-auth.js';
import { loadUserBySession } from '../store/users.js';
import { readSessionCookie } from '../util/session.js';
import { reverseGeocodeLocation } from '../integrations/nominatim.js';

export const vehiclesRouter = Router();

// getTeslaAccess throws tagged errors — map them to HTTP. RevokedError →
// 401 (the SPA should re-OAuth); ConfigError → 502 (server misconfig,
// page someone); TransientError → 503 (Tesla flaking, retry shortly).
function mapTeslaAccessError(res, e) {
  if (e instanceof RevokedError) return res.status(401).json({ detail: 'Tesla authorization expired — re-authorize at https://sweeper.bitvox.me/' });
  if (e instanceof ConfigError) return res.status(502).json({ detail: 'Tesla OAuth misconfigured (server-side)' });
  if (e instanceof TransientError) return res.status(503).json({ detail: 'Tesla is temporarily unavailable — try again shortly' });
  return res.status(502).json({ detail: 'Upstream error' });
}

// Resolve a usable Tesla access_token: cookie path (broker via
// getTeslaAccess on the bound record) or legacy `token` body. Returns
// the token string, or null after sending a 401/4xx/5xx itself — the
// caller should just `return` on null.
async function resolveAccess(req, res) {
  const cookieUser = loadUserBySession(readSessionCookie(req));
  if (cookieUser) {
    try { return await getTeslaAccess(cookieUser.id); }
    catch (e) { mapTeslaAccessError(res, e); return null; }
  }
  if (req.body?.token) return req.body.token;
  res.status(401).json({ detail: 'Not signed in' });
  return null;
}

vehiclesRouter.post('/api/vehicles', wrap(async (req, res) => {
  const accessToken = await resolveAccess(req, res);
  if (!accessToken) return;
  console.log('[vehicles] Fetching vehicle list');
  let vehicles;
  try { vehicles = await listVehicles(accessToken); }
  catch (e) {
    if (e.status === 401) return res.status(401).json({ detail: 'Invalid or expired Tesla token' });
    console.error('[vehicles] Tesla API error:', e.status, e.message);
    return res.status(e.status || 502).json({ detail: e.message });
  }
  console.log(`[vehicles] Found ${vehicles.length} vehicle(s)`);
  res.json({ vehicles });
}));

vehiclesRouter.post('/api/check', wrap(async (req, res) => {
  const cookieUser = loadUserBySession(readSessionCookie(req));
  let vid = req.body?.vehicle_id || cookieUser?.vehicle_id || null;

  // Stub short-circuit (once vid is resolved) — skip Tesla entirely.
  if (isStubVehicle(vid)) {
    console.log('[check] returning stub vehicle data');
    return res.json({ vehicle_name: STUB_VEHICLE_NAME, latitude: STUB_VEHICLE_LAT, longitude: STUB_VEHICLE_LNG, battery_level: 78 });
  }

  let accessToken;
  if (cookieUser) {
    try { accessToken = await getTeslaAccess(cookieUser.id); } catch (e) { return mapTeslaAccessError(res, e); }
  } else if (req.body?.token) {
    accessToken = req.body.token;
  } else {
    return res.status(401).json({ detail: 'Not signed in' });
  }

  if (!vid) {
    let list;
    try { list = await listVehicles(accessToken); }
    catch (e) { return res.status(e.status === 401 ? 401 : (e.status || 502)).json({ detail: e.message }); }
    if (!list.length) return res.json({ no_vehicles: true });
    vid = list[0].id;
  }

  console.log(`[check] Getting location for vehicle ${vid}`);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
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

vehiclesRouter.post('/api/reverse-geocode', wrap(async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  // Reject non-numeric coords at the boundary — otherwise they hit the
  // Nominatim cache as "NaN,NaN" and pollute the slot for every other
  // bad-input call on the same server lifetime.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ detail: 'lat and lng must be numeric' });
  }
  res.json(await reverseGeocodeLocation(lat, lng));
}));

// Tesla Fleet API + reverse-geocode proxies for the SPA.
// /api/vehicles lists, /api/check fetches GPS (stub short-circuit +
// wake/poll on 408), /api/reverse-geocode wraps Nominatim.
//
// Auth: the signed `session` cookie. The server brokers a Tesla
// access_token via getTeslaAccess (which owns refresh-token rotation).
// Phase 8 removed the legacy `token` body fallback — the BFF SPA on
// sweeper.bitvox.me has been the only client since deploy and zero
// legacy hits showed in logs.

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { rateLimit } from '../middleware/ratelimit.js';
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

// Resolve a usable Tesla access_token: read the session cookie, find
// the bound user record, broker a token via getTeslaAccess. Returns the
// token string, or null after sending a 401/4xx/5xx itself — the caller
// should just `return` on null.
async function resolveAccess(req, res) {
  const cookieUser = loadUserBySession(readSessionCookie(req));
  if (!cookieUser) { res.status(401).json({ detail: 'Not signed in' }); return null; }
  try { return await getTeslaAccess(cookieUser.id); }
  catch (e) { mapTeslaAccessError(res, e); return null; }
}

vehiclesRouter.post('/api/vehicles', wrap(async (req, res) => {
  const accessToken = await resolveAccess(req, res);
  if (!accessToken) return;
  console.log('[vehicles] Fetching vehicle list');
  let vehicles;
  try { vehicles = await listVehicles(accessToken); } // listVehicles logs its own non-401 Tesla errors
  catch (e) { return res.status(e.status || 502).json({ detail: e.message }); }
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

  if (!cookieUser) return res.status(401).json({ detail: 'Not signed in' });
  let accessToken;
  try { accessToken = await getTeslaAccess(cookieUser.id); } catch (e) { return mapTeslaAccessError(res, e); }

  if (!vid) {
    let list;
    try { list = await listVehicles(accessToken); }
    catch (e) { return res.status(e.status || 502).json({ detail: e.message }); }
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

vehiclesRouter.post('/api/reverse-geocode', rateLimit({ perMinute: 12 }), wrap(async (req, res) => {
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

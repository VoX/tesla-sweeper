// Tesla Fleet API + reverse-geocode proxies for the SPA.
// /api/vehicles lists, /api/check fetches GPS (stub short-circuit +
// wake/poll on 408), /api/reverse-geocode wraps Nominatim.

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import {
  STUB_VEHICLE_ENABLED, STUB_VEHICLE_ID, STUB_VEHICLE_VIN, STUB_VEHICLE_LAT, STUB_VEHICLE_LNG,
  STUB_VEHICLE_NAME, isStubVehicle, fetchVehicleData, TESLA_BASE,
} from '../integrations/tesla.js';
import { reverseGeocodeLocation } from '../integrations/nominatim.js';
import { fetchWithTimeout } from '../util/fetch.js';

export const vehiclesRouter = Router();

vehiclesRouter.post('/api/vehicles', wrap(async (req, res) => {
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
  // Stringify v.id at the boundary — Tesla returns 16-digit ints above
  // MAX_SAFE_INTEGER, JSON round-tripping loses precision, and the SPA's
  // <select> binds value as a string anyway. One coercion here keeps
  // every downstream comparison consistent.
  const out = vehicles.map(v => ({ id: String(v.id), name: v.display_name || 'Unknown', vin: v.vin, state: v.state }));
  if (STUB_VEHICLE_ENABLED && out.length === 0) {
    console.log('[vehicles] injecting stub test vehicle');
    out.push({ id: String(STUB_VEHICLE_ID), name: STUB_VEHICLE_NAME, vin: STUB_VEHICLE_VIN, state: 'online' });
  }
  res.json({ vehicles: out });
}));

vehiclesRouter.post('/api/check', wrap(async (req, res) => {
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

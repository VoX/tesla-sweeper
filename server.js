import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const RECOLLECT_BASE = 'https://api.recollect.net/api';
const RECOLLECT_SERVICE = 349;
const UA = 'TeslaSweeper/1.0';

async function proxy(url, options = {}) {
  const res = await fetch(url, options);
  return res;
}

// Check vehicle location
app.post('/api/check', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ detail: 'Token required' });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    const vehiclesRes = await proxy(`${TESLA_BASE}/api/1/vehicles`, { headers });
    if (vehiclesRes.status === 401) return res.status(401).json({ detail: 'Invalid or expired Tesla token' });
    if (!vehiclesRes.ok) return res.status(vehiclesRes.status).json({ detail: await vehiclesRes.text() });

    const vehicles = (await vehiclesRes.json()).response || [];
    if (!vehicles.length) return res.status(404).json({ detail: 'No vehicles found on this account' });

    const vehicle = vehicles[0];
    const locRes = await proxy(
      `${TESLA_BASE}/api/1/vehicles/${vehicle.id}/vehicle_data?endpoints=location_data`,
      { headers }
    );
    if (locRes.status === 408) return res.status(408).json({ detail: 'Vehicle is asleep. Open the Tesla app to wake it, then retry.' });
    if (!locRes.ok) return res.status(locRes.status).json({ detail: await locRes.text() });

    const driveState = (await locRes.json()).response?.drive_state || {};
    const { latitude, longitude } = driveState;
    if (latitude == null || longitude == null) return res.status(404).json({ detail: 'Could not determine vehicle location' });

    res.json({ vehicle_name: vehicle.display_name || 'Unknown', latitude, longitude });
  } catch (e) {
    res.status(502).json({ detail: e.message });
  }
});

// Reverse geocode
app.post('/api/reverse-geocode', async (req, res) => {
  const { lat, lng } = req.body;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 18, addressdetails: 1 });
    const geoRes = await proxy(`${NOMINATIM_BASE}/reverse?${params}`, { headers: { 'User-Agent': UA } });
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
  } catch (e) {
    res.status(502).json({ detail: e.message });
  }
});

// Sweep check
app.post('/api/sweep-check', async (req, res) => {
  const { address, tz_offset } = req.body;
  if (!address) return res.status(400).json({ detail: 'Address required' });

  try {
    const today = tz_offset != null
      ? new Date(new Date().getTime() + (-tz_offset - new Date().getTimezoneOffset()) * 60000)
      : new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    const beforeStr = future.toISOString().slice(0, 10);
    const tomorrowDate = new Date(today);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    // Address suggest
    const suggestParams = new URLSearchParams({ q: address, locale: 'en-US' });
    const suggestRes = await proxy(
      `${RECOLLECT_BASE}/areas/Somerville/services/${RECOLLECT_SERVICE}/address-suggest?${suggestParams}`,
      { headers: { 'User-Agent': UA } }
    );
    if (!suggestRes.ok) return res.status(502).json({ detail: 'Recollect address suggest error' });

    const suggestions = await suggestRes.json();
    if (!suggestions.length) return res.json({ found: false, message: 'Address not found in Somerville sweeping database' });

    const place = suggestions[0];
    const placeId = place.place_id;

    // Events
    const eventsParams = new URLSearchParams({ after: todayStr, before: beforeStr, locale: 'en-US' });
    const eventsRes = await proxy(
      `${RECOLLECT_BASE}/places/${placeId}/services/${RECOLLECT_SERVICE}/events?${eventsParams}`,
      { headers: { 'User-Agent': UA } }
    );
    if (!eventsRes.ok) return res.status(502).json({ detail: 'Recollect events error' });

    const eventsData = await eventsRes.json();
    const rawEvents = Array.isArray(eventsData) ? eventsData : (eventsData.events || eventsData);

    const sweepEvents = [];
    for (const event of rawEvents) {
      for (const flag of (event.flags || [])) {
        const name = flag.name || '';
        if (!name.toLowerCase().includes('sweeping')) continue;
        const m = name.match(/(\d{1,2})(AM|PM)_(\d{1,2})(AM|PM)/);
        const time = m ? `${m[1]}:00 ${m[2]} - ${m[3]}:00 ${m[4]}` : name;
        sweepEvents.push({
          date: event.day || '',
          type: name,
          side: name.includes('EVEN') ? 'even' : name.includes('ODD') ? 'odd' : 'both',
          time,
        });
      }
    }

    // House number parity
    const houseMatch = address.trim().match(/^(\d+)/);
    const houseNum = houseMatch ? parseInt(houseMatch[1]) : null;
    const carSide = houseNum ? (houseNum % 2 === 0 ? 'even' : 'odd') : null;

    const sweepingToday = sweepEvents.filter(e => e.date === todayStr);
    const sweepingTomorrow = sweepEvents.filter(e => e.date === tomorrowStr);

    const sideLabel = (events) => [...new Set(events.map(e => e.side + ' side'))].join(', ');
    const carMatches = (events) => !carSide || events.some(e => e.side === carSide);

    let status, title, message;

    if (sweepingToday.length) {
      const sides = sideLabel(sweepingToday);
      if (carMatches(sweepingToday)) {
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
      const daysUntil = Math.ceil((new Date(e.date) - new Date(todayStr)) / 86400000);
      status = 'safe'; title = "You're Good";
      message = `Next sweep in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}: ${e.date} (${e.side} side, ${e.time})`;
    } else {
      status = 'safe'; title = 'No Sweeping Scheduled';
      message = 'No sweeping events found in the next 30 days.';
    }

    const daysUntilNext = sweepEvents.length
      ? Math.ceil((new Date(sweepEvents[0].date) - new Date(todayStr)) / 86400000)
      : null;

    res.json({
      found: true,
      place_name: place.name || address,
      place_id: placeId,
      status, title, message,
      sweep_events: sweepEvents,
      car_side: carSide,
      house_num: houseNum,
      days_until_next: daysUntilNext,
    });
  } catch (e) {
    res.status(502).json({ detail: e.message });
  }
});

// OAuth start
app.post('/api/oauth/start', (req, res) => {
  const { client_id, redirect_uri, scope = 'openid offline_access vehicle_device_data vehicle_location' } = req.body;
  const state = crypto.randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri, scope, state });
  res.json({ url: `https://auth.tesla.com/oauth2/v3/authorize?${params}`, state });
});

// OAuth callback
app.post('/api/oauth/callback', async (req, res) => {
  const { client_id, client_secret, redirect_uri, code } = req.body;
  try {
    const tokenRes = await proxy('https://auth.tesla.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id, client_secret, code, redirect_uri }),
    });
    if (!tokenRes.ok) return res.status(tokenRes.status).json({ detail: await tokenRes.text() });

    const data = await tokenRes.json();
    res.json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      token_type: data.token_type,
    });
  } catch (e) {
    res.status(502).json({ detail: e.message });
  }
});

// OAuth refresh
app.post('/api/oauth/refresh', async (req, res) => {
  const { client_id, client_secret, refresh_token } = req.body;
  try {
    const tokenRes = await proxy('https://auth.tesla.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id, client_secret, refresh_token }),
    });
    if (!tokenRes.ok) return res.status(tokenRes.status).json({ detail: await tokenRes.text() });

    const data = await tokenRes.json();
    res.json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    });
  } catch (e) {
    res.status(502).json({ detail: e.message });
  }
});

// Serve built React app in production
app.use(express.static(join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 20040;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tesla Sweeper running on http://127.0.0.1:${PORT}`);
});

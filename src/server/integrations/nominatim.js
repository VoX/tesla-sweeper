// Nominatim (OSM reverse geocoding) — rate-limited 1 req/sec per usage policy.

import { fetchWithTimeout, UA } from '../util/fetch.js';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

let lastCall = 0;
export async function nominatimFetch(url, options) {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  return fetchWithTimeout(url, options);
}

export async function reverseGeocodeLocation(lat, lng) {
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

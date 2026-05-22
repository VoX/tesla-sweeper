// Nominatim (OSM reverse geocoding). Compliance requirements per
// https://operations.osmfoundation.org/policies/nominatim/ :
//   - max 1 req/sec (enforced via the nominatimFetch queue below)
//   - User-Agent must identify the app + contact (see util/fetch.js)
//   - "Results must be cached on your side. Clients sending repeatedly
//     the same query may be classified as faulty and blocked."
// The cron runs daily for the same parked-car coordinates; without
// caching we'd send Nominatim the same lat/lng every 24h forever.

import { fetchWithTimeout, UA } from '../util/fetch.js';

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

// 24h TTL on reverse-geocode results. Lat/lng rounded to 5 decimals
// (~1.1 m precision at Somerville's latitude) so micro-drift between
// pin drags or Tesla GPS samples reuses the same cache slot. Map is
// unbounded by design — at ~1-2 subs + occasional dev pin-drags,
// hundreds of entries weigh ~tens of KB. Hard cap added if it ever
// becomes a memory concern in prod.
const REVERSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const reverseCache = new Map();

// Reserve the slot BEFORE awaiting — concurrent callers race past the
// gate otherwise (both compute wait against the same lastCall, both
// sleep, both fire simultaneously, violating the 1 req/sec rule).
let nextSlot = 0;
export async function nominatimFetch(url, options) {
  const now = Date.now();
  const fireAt = Math.max(now, nextSlot);
  nextSlot = fireAt + 1000;
  if (fireAt > now) await new Promise(r => setTimeout(r, fireAt - now));
  return fetchWithTimeout(url, options);
}

export async function reverseGeocodeLocation(lat, lng) {
  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.at < REVERSE_CACHE_TTL_MS) return hit.value;

  const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 18, addressdetails: 1 });
  const res = await nominatimFetch(`${NOMINATIM_BASE}/reverse?${params}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  const a = data.address || {};
  const out = {
    street: a.road || '',
    // OSM emits house_number formats Recollect's address-suggest can't match:
    // `;`/`,`-joined multi-addresses ("58;60"), `-`/`/` ranges ("134-136",
    // "151/153"), letter/rear suffixes ("215B", "29R"), and fractionals
    // ("25 1/2"). Recollect only matches a bare leading integer, so reduce to
    // that for the lookup (check.js already uses the same `^\d+` for parity).
    // Both the SPA and cron build the lookup address from this; display_name
    // keeps the raw OSM string.
    house_number: (String(a.house_number || '').match(/^\d+/)?.[0]) || '',
    city: a.city || a.town || a.village || '',
    state: a.state || '',
    display_name: data.display_name || '',
  };
  reverseCache.set(key, { at: Date.now(), value: out });
  return out;
}

// localStorage cache for "Check My Car" results — survives a refresh
// for ~6h so subsequent page loads hydrate without waking the Tesla.
// Mismatched-version reads return null so a future schema change can
// invalidate cleanly without a manual purge.

const CHECK_CACHE_MS = 6 * 60 * 60 * 1000;
const CHECK_CACHE_KEY = 'tesla_last_check';
const CHECK_CACHE_VERSION = 1;

export function readCachedCheck(vehicleId) {
  if (!vehicleId) return null;
  try {
    const c = JSON.parse(localStorage.getItem(CHECK_CACHE_KEY));
    if (!c || c.v !== CHECK_CACHE_VERSION || c.vehicle_id !== vehicleId) return null;
    if (Date.now() - c.at > CHECK_CACHE_MS) return null;
    return c;
  } catch { return null; }
}

export function saveCachedCheck(vehicleId, payload) {
  if (!vehicleId) return;
  try {
    localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({
      v: CHECK_CACHE_VERSION, vehicle_id: vehicleId, at: Date.now(), ...payload,
    }));
  } catch {}
}

export function clearCachedCheck() {
  try { localStorage.removeItem(CHECK_CACHE_KEY); } catch {}
}

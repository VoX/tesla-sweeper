// localStorage cache for "Check My Car" results — survives a refresh
// for ~6h so subsequent page loads hydrate without waking the Tesla.
// Mismatched-version reads return null so a future schema change can
// invalidate cleanly without a manual purge.

const CHECK_CACHE_MS = 6 * 60 * 60 * 1000;
const CHECK_CACHE_KEY = 'tesla_last_check';
const CHECK_CACHE_VERSION = 2; // v2: adds the day/noon basis stamp

// The sweep verdict is a function of WHICH day it is and whether it is past
// noon — not just of wall-clock age. A check cached at 11pm is stale at 7am
// the next morning even though it is only 8h old; one cached at 11am is
// stale at 12:01pm. Stamp the basis and invalidate on any mismatch.
export function cacheBasis(now = new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${d}|${now.getHours() >= 12 ? 'pm' : 'am'}`;
}

export function readCachedCheck(vehicleId) {
  if (!vehicleId) return null;
  try {
    const c = JSON.parse(localStorage.getItem(CHECK_CACHE_KEY));
    if (!c || c.v !== CHECK_CACHE_VERSION || c.vehicle_id !== vehicleId) return null;
    if (Date.now() - c.at > CHECK_CACHE_MS) return null;
    if (c.basis !== cacheBasis()) return null;
    return c;
  } catch { return null; }
}

export function saveCachedCheck(vehicleId, payload) {
  if (!vehicleId) return;
  try {
    localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({
      v: CHECK_CACHE_VERSION, vehicle_id: vehicleId, at: Date.now(), basis: cacheBasis(), ...payload,
    }));
  } catch {}
}

export function clearCachedCheck() {
  try { localStorage.removeItem(CHECK_CACHE_KEY); } catch {}
}

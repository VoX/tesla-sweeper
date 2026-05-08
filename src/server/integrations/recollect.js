// Recollect API — Somerville street-sweeping schedule data. No auth.
// Two endpoints in use: address-suggest (fuzzy match → place_id) and
// events (sweep schedule for a place over a date range).

const RECOLLECT_BASE = 'https://api.recollect.net/api';
const RECOLLECT_SERVICE = 349; // Somerville
const UA = 'TeslaSweeper/1.0';
const FETCH_TIMEOUT = 12000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
}

export async function suggestAddress(address) {
  const res = await fetchWithTimeout(
    `${RECOLLECT_BASE}/areas/Somerville/services/${RECOLLECT_SERVICE}/address-suggest?${new URLSearchParams({ q: address, locale: 'en-US' })}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error(`Recollect address suggest ${res.status}`);
  return res.json();
}

export async function fetchSweepEvents(place_id, after, before) {
  const res = await fetchWithTimeout(
    `${RECOLLECT_BASE}/places/${place_id}/services/${RECOLLECT_SERVICE}/events?${new URLSearchParams({ after, before, locale: 'en-US' })}`,
    { headers: { 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error(`Recollect events ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.events || []);
}

// Parse a Recollect events array into a list of sweep events with
// normalized {date, side, time}. Anything not flagged as a sweep is
// dropped.
export function parseSweepFlags(rawEvents) {
  const out = [];
  for (const event of rawEvents) {
    if (!event.flags || !event.day) continue;
    for (const flag of event.flags) {
      const name = flag.name || '';
      if (!name.toLowerCase().includes('sweeping')) continue;
      const m = name.match(/(\d{1,2})(AM|PM)_(\d{1,2})(AM|PM)/);
      out.push({
        date: event.day,
        type: name,
        side: name.includes('EVEN') ? 'even' : name.includes('ODD') ? 'odd' : 'both',
        time: m ? `${m[1]}:00 ${m[2]} - ${m[3]}:00 ${m[4]}` : name,
      });
    }
  }
  return out;
}

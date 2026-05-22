// Single sweep check: address → Recollect events + OSM side detection
// → status/title/message. Pure composition; no external state.

import { suggestAddress, fetchSweepEvents, parseSweepFlags } from '../integrations/recollect.js';
import { whichSide } from '../integrations/overpass.js';

// Recollect has gaps — some real, swept house numbers simply aren't indexed
// (e.g. evens 30-38 on Atherton Street). Sweeping is posted per street-side, so
// when the exact number is missing we probe outward (nearest first) for an
// indexed number on the SAME side (same parity) and reuse its schedule. Bounded
// so a genuinely uncovered street fails fast instead of spraying queries.
async function nearestSameSideAddress(houseNum, street) {
  if (!Number.isFinite(houseNum) || !street) return null;
  const MAX_OFFSET = 12; // same-parity steps of 2 → up to 6 houses each way
  for (let delta = 2; delta <= MAX_OFFSET; delta += 2) {
    for (const n of [houseNum + delta, houseNum - delta]) {
      if (n <= 0) continue;
      const cands = await suggestAddress(`${n} ${street}`);
      if (cands.length) return cands[0];
    }
  }
  return null;
}

export async function runSweepCheck({ address, today_date, past_noon = false, lat, lng, city }) {
  // The geocoded city is the only reliable signal the car is parked OUTSIDE
  // Somerville — Recollect's suggest can fuzzy-match a same-named street in
  // another town, so short-circuit before we ever query it.
  if (city && city.trim().toLowerCase() !== 'somerville') {
    return { found: false, message: `This location is in ${city}, outside Somerville's street-sweeping coverage.` };
  }
  const todayStr = today_date || new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T12:00:00Z');
  const future = new Date(today); future.setDate(future.getDate() + 30);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const houseMatch = address.trim().match(/^(\d+)/);
  const parsedHouseNum = houseMatch ? parseInt(houseMatch[1]) : null;
  const streetName = address.trim().replace(/^\d+\s*/, '').trim();

  let place = (await suggestAddress(address))[0] || null;
  let nearestNote = null;
  if (!place) {
    // Exact address isn't in Recollect — fall back to the nearest indexed
    // address on the same street-side (its sweeping schedule applies here too).
    place = await nearestSameSideAddress(parsedHouseNum, streetName);
    if (!place) return { found: false, message: 'Address not found in Somerville sweeping database' };
    nearestNote = `nearest indexed address on your side: ${place.name}`;
  }

  const rawEvents = await fetchSweepEvents(place.place_id, todayStr, future.toISOString().slice(0, 10));
  const sweepEvents = parseSweepFlags(rawEvents);

  // OSM-based geometric detection beats houseNum%2 when a car parks
  // across from its own address. Fall back to parity if OSM lacks
  // building data on the street or the lookup throws.
  let carSide = null;
  let sideSource = null;
  let sideDetection = null;
  try {
    sideDetection = await whichSide(lat, lng);
    if (sideDetection.side === 'odd' || sideDetection.side === 'even') {
      carSide = sideDetection.side;
      sideSource = 'osm';
    }
  } catch (e) {
    console.warn('[sweep-check] whichSide threw:', e.message);
  }
  if (!carSide && parsedHouseNum) {
    carSide = parsedHouseNum % 2 === 0 ? 'even' : 'odd';
    sideSource = 'house_parity';
    // [fallback] in journalctl = OSM no-data path engaged; grep this
    // to gauge how often the parity heuristic is carrying the result.
    console.warn(`[sweep-check] [fallback] OSM no-data, using parity for #${parsedHouseNum} → ${carSide}`);
  }
  // Canonical house number for display: prefer the OSM-detected
  // car-side number (the actual house on the car's curb); fall back
  // to the address-parsed one when OSM has no data. Used by both the
  // server-side message templates and the SPA's Details card so they
  // never disagree.
  const houseNum = sideDetection?.car_house_number ?? parsedHouseNum;

  const sweepingToday = sweepEvents.filter(e => e.date === todayStr);
  const sweepingTomorrow = sweepEvents.filter(e => e.date === tomorrowStr);
  const daysUntilNext = sweepEvents.length
    ? Math.max(0, Math.ceil((new Date(sweepEvents[0].date) - new Date(todayStr)) / 86400000))
    : null;

  const sideLabel = (events) => [...new Set(events.map(e => e.side + ' side'))].join(', ');
  const carMatches = (events) => !carSide || events.some(e => e.side === carSide);

  let status, title, message;
  if (sweepingToday.length) {
    const sides = sideLabel(sweepingToday);
    if (past_noon) {
      status = 'info'; title = 'Sweeping Done for Today';
      message = `Sweeping was scheduled today (${sides}, 8AM-12PM). It's past noon — you're clear.`;
    } else if (carMatches(sweepingToday)) {
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
    status = 'safe'; title = "You're Good";
    message = `Next sweep in ${daysUntilNext} day${daysUntilNext !== 1 ? 's' : ''}: ${e.date} (${e.side} side, ${e.time})`;
  } else {
    status = 'safe'; title = 'No Sweeping Scheduled';
    message = 'No sweeping events found in the next 30 days.';
  }

  if (nearestNote) message += ` [${nearestNote}]`;

  return {
    found: true,
    place_name: place.name || address,
    place_id: place.place_id,
    status, title, message,
    nearest_note: nearestNote,
    sweep_events: sweepEvents,
    car_side: carSide,
    side_source: sideSource,
    side_detection: sideDetection,
    house_num: houseNum,
    days_until_next: daysUntilNext,
    latitude: lat,
    longitude: lng,
  };
}

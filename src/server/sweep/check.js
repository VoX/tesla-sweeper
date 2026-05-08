// Run a single sweep check: address → Recollect events + OSM side
// detection → status/title/message + canonical house number. Pure
// composition over the integration modules; no external state.

import { suggestAddress, fetchSweepEvents, parseSweepFlags } from '../integrations/recollect.js';
import { whichSide } from '../integrations/overpass.js';

export async function runSweepCheck({ address, today_date, past_noon = false, lat, lng }) {
  const todayStr = today_date || new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T12:00:00Z');
  const future = new Date(today); future.setDate(future.getDate() + 30);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const suggestions = await suggestAddress(address);
  if (!suggestions.length) return { found: false, message: 'Address not found in Somerville sweeping database' };
  const place = suggestions[0];

  const rawEvents = await fetchSweepEvents(place.place_id, todayStr, future.toISOString().slice(0, 10));
  const sweepEvents = parseSweepFlags(rawEvents);

  const houseMatch = address.trim().match(/^(\d+)/);
  const parsedHouseNum = houseMatch ? parseInt(houseMatch[1]) : null;

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

  return {
    found: true,
    place_name: place.name || address,
    place_id: place.place_id,
    status, title, message,
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

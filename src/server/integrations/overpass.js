// OSM Overpass-based side detection. Picks the closest named drivable
// highway segment to a lat/lng, takes the 2D cross-product sign to know
// which side of A→B the pin is on, then queries OSM buildings tagged
// addr:street=<road> and tallies even-vs-odd house numbers per side to
// map cross sign → odd/even parity. Beats houseNum%2 when a car parks
// across from its own address.

const UA = 'TeslaSweeper/1.0';
const FETCH_TIMEOUT = 12000;

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
}

const overpass = (q) =>
  fetchWithTimeout(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': UA } });

export async function whichSide(lat, lng) {
  // Filter to *named* drivable highways — sidewalks/footpaths digitized
  // parallel to the real street would otherwise win the closest-segment
  // race when the pin is near a curb.
  const drivableHighways = '^(residential|primary|secondary|tertiary|unclassified|living_street|trunk|motorway|primary_link|secondary_link|tertiary_link|trunk_link|motorway_link)$';
  const namedQ = `[out:json][timeout:10];way(around:50,${lat},${lng})[highway~"${drivableHighways}"][name];out geom;`;

  const r0 = await overpass(namedQ);
  if (!r0.ok) throw new Error(`Overpass ${r0.status}`);
  const ways = ((await r0.json()).elements || []).filter(e => e.type === 'way' && e.geometry?.length >= 2);
  if (!ways.length) return { side: 'unknown', error: 'no nearby roads in OSM' };

  let best = null;
  for (const way of ways) {
    const geom = way.geometry.map(n => ({ lat: n.lat, lng: n.lon }));
    for (let i = 0; i < geom.length - 1; i++) {
      const A = geom[i], B = geom[i + 1];
      const r = projectPointToSegment({ lat, lng }, A, B);
      if (!best || r.dist < best.dist) best = { way, A, B, ...r };
    }
  }
  if (!best) return { side: 'unknown', error: 'no segments' };

  const cross = crossSign(best.A, best.B, { lat, lng });
  const offsetM = haversineMeters(lat, lng, best.foot.lat, best.foot.lng);

  // Buildings on this street within ~80m of the foot. Nominatim reverse-
  // geocode isn't dense enough to distinguish curbs (both perpendicular
  // probes can return the same near-side house number), so we go to OSM.
  const wayName = best.way.tags?.name || '';
  const buildings = [];
  if (wayName) {
    // OSM names are public-edit data — escape \ first, then ", then strip
    // control chars so a malformed way name can't break the literal.
    const escName = wayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
    const bq = `[out:json][timeout:10];(way(around:80,${best.foot.lat},${best.foot.lng})["building"]["addr:street"="${escName}"];node(around:80,${best.foot.lat},${best.foot.lng})["addr:housenumber"]["addr:street"="${escName}"];);out tags center;`;
    try {
      const r = await overpass(bq);
      if (r.ok) {
        const j = await r.json();
        for (const e of j.elements || []) {
          const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
          const hn = e.tags?.['addr:housenumber'];
          if (!c || !hn) continue;
          const m = String(hn).match(/(\d+)/);
          if (!m) continue;
          buildings.push({ num: parseInt(m[1], 10), lat: c.lat, lng: c.lon });
        }
      }
    } catch {}
  }

  let leftEven = 0, leftOdd = 0, rightEven = 0, rightOdd = 0;
  const leftBuildings = [], rightBuildings = [];
  for (const b of buildings) {
    const s = crossSign(best.A, best.B, b);
    if (s > 0) {
      leftBuildings.push(b);
      if (b.num % 2 === 0) leftEven++; else leftOdd++;
    } else if (s < 0) {
      rightBuildings.push(b);
      if (b.num % 2 === 0) rightEven++; else rightOdd++;
    }
  }
  // Vote-count which hypothesis fits the buildings observed: "left of
  // A→B is the even curb" gets one vote per left-even and one per right-
  // odd; the inverse hypothesis gets the mirror. Handles single-side-
  // data and corner-lot mixed addressing in one expression. Tie → null.
  const leftIsEven = leftEven + rightOdd;
  const leftIsOdd = leftOdd + rightEven;
  const evenSideSign = leftIsEven > leftIsOdd ? +1 : leftIsOdd > leftIsEven ? -1 : null;

  let side = 'unknown';
  if (evenSideSign != null && cross !== 0) {
    side = (cross === evenSideSign) ? 'even' : 'odd';
  }

  // Closest building on each side — for response display.
  const f = best.foot;
  const nearestOf = (arr) => {
    let bb = null, bd = Infinity;
    for (const b of arr) {
      const d = haversineMeters(f.lat, f.lng, b.lat, b.lng);
      if (d < bd) { bd = d; bb = b; }
    }
    return bb ? bb.num : null;
  };
  const leftRep = nearestOf(leftBuildings);
  const rightRep = nearestOf(rightBuildings);
  const carNum = cross > 0 ? leftRep : cross < 0 ? rightRep : null;
  const oppositeNum = cross > 0 ? rightRep : cross < 0 ? leftRep : null;

  return {
    side,
    road_name: best.way.tags?.name || best.way.tags?.ref || 'unknown',
    perpendicular_offset_m: Math.round(offsetM * 10) / 10,
    cross_sign: cross,
    car_house_number: carNum,
    opposite_house_number: oppositeNum,
    buildings_seen: buildings.length,
    side_parity: { left_even: leftEven, left_odd: leftOdd, right_even: rightEven, right_odd: rightOdd },
    even_side: evenSideSign === +1 ? 'left of A→B' : evenSideSign === -1 ? 'right of A→B' : 'unknown',
    way_id: best.way.id,
    segment: { A: best.A, B: best.B, t: best.t, foot: best.foot },
  };
}

// Project P onto segment AB (lat/lng treated as planar — fine at street scale).
// Returns { dist, t (clamped 0..1), foot (the projection point) }.
function projectPointToSegment(P, A, B) {
  const dx = B.lng - A.lng, dy = B.lat - A.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return { dist: Math.hypot(P.lng - A.lng, P.lat - A.lat), t: 0, foot: { lat: A.lat, lng: A.lng } };
  }
  let t = ((P.lng - A.lng) * dx + (P.lat - A.lat) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const fx = A.lng + dx * t, fy = A.lat + dy * t;
  return { dist: Math.hypot(P.lng - fx, P.lat - fy), t, foot: { lat: fy, lng: fx } };
}

function crossSign(A, B, P) {
  const dx = B.lng - A.lng, dy = B.lat - A.lat;
  const px = P.lng - A.lng, py = P.lat - A.lat;
  const c = dx * py - dy * px;
  return c > 0 ? 1 : c < 0 ? -1 : 0;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

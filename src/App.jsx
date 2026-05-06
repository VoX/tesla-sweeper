import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { loadLeaflet } from './leaflet-loader.js';

const API = import.meta.env.DEV ? '/sweeper/api' : 'api';

// Cache successful vehicle checks for 6h so subsequent page loads
// hydrate from localStorage instead of waking the car. The "Check My
// Car" button still bypasses cache when the user wants fresh data.
const CHECK_CACHE_MS = 6 * 60 * 60 * 1000;
const CHECK_CACHE_KEY = 'tesla_last_check';
const CHECK_CACHE_VERSION = 1;
function readCachedCheck(vehicleId) {
  if (!vehicleId) return null;
  try {
    const c = JSON.parse(localStorage.getItem(CHECK_CACHE_KEY));
    if (!c || c.v !== CHECK_CACHE_VERSION || c.vehicle_id !== vehicleId) return null;
    if (Date.now() - c.at > CHECK_CACHE_MS) return null;
    return c;
  } catch { return null; }
}
function saveCachedCheck(vehicleId, payload) {
  if (!vehicleId) return;
  try {
    localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({
      v: CHECK_CACHE_VERSION, vehicle_id: vehicleId, at: Date.now(), ...payload,
    }));
  } catch {}
}

async function handleRes(res) {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: 'API error' }));
    throw new Error(e.detail || 'API error');
  }
  return res.json();
}
async function post(url, body, signal) {
  return handleRes(await fetch(`${API}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }));
}
async function get(url) { return handleRes(await fetch(`${API}/${url}`)); }

function StatusBox({ status, title, message }) {
  const icon = { danger: '\u{1F6A8}', warning: '\u26A0\uFE0F', safe: '\u2705', info: '\u2139\uFE0F' }[status] || '';
  // Danger gets role=alert + assertive live region so screen readers
  // interrupt; the rest get polite status updates.
  return (
    <div className={`status-box ${status}`} role={status === 'danger' ? 'alert' : 'status'} aria-live={status === 'danger' ? 'assertive' : 'polite'}>
      <h2>{icon} {title}</h2>
      <p>{message}</p>
    </div>
  );
}

function Row({ label, value }) {
  return <div className="row"><span className="label">{label}</span><span>{value}</span></div>;
}

function MapView({ lat, lng, street, segment, draggable, onPinMove, popupLabel = 'Your Car' }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markerRef = useRef(null);
  const segOverlayRef = useRef(null);
  const footOverlayRef = useRef(null);
  const onPinMoveRef = useRef(onPinMove);
  const [L, setL] = useState(null);

  // Keep latest dragend handler in a ref so the marker's listener
  // (attached once at map init) always calls the current closure.
  useEffect(() => { onPinMoveRef.current = onPinMove; }, [onPinMove]);

  useEffect(() => {
    if (lat != null) loadLeaflet().then(setL);
  }, [lat]);

  useEffect(() => () => {
    if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; markerRef.current = null; segOverlayRef.current = null; footOverlayRef.current = null; }
  }, []);

  useEffect(() => {
    if (!L || !mapRef.current || lat == null) return;
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '\u00A9 OpenStreetMap' }).addTo(mapInstance.current);
      markerRef.current = L.marker([lat, lng], { draggable: !!draggable }).addTo(mapInstance.current);
      if (draggable) {
        markerRef.current.on('dragend', () => {
          const ll = markerRef.current.getLatLng();
          onPinMoveRef.current?.(ll.lat, ll.lng);
        });
      }
    } else {
      mapInstance.current.setView([lat, lng], 17);
      markerRef.current.setLatLng([lat, lng]);
    }
    const popup = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = popupLabel;
    popup.appendChild(b);
    popup.appendChild(document.createElement('br'));
    popup.appendChild(document.createTextNode(street || 'Unknown'));
    markerRef.current.bindPopup(popup);
    if (!draggable) markerRef.current.openPopup();
  }, [L, lat, lng, street, draggable, popupLabel]);

  // Draw chosen road segment + perpendicular foot whenever segment changes.
  useEffect(() => {
    if (!L || !mapInstance.current) return;
    const map = mapInstance.current;
    if (segOverlayRef.current) { map.removeLayer(segOverlayRef.current); segOverlayRef.current = null; }
    if (footOverlayRef.current) { map.removeLayer(footOverlayRef.current); footOverlayRef.current = null; }
    if (!segment?.A || !segment?.B) return;
    segOverlayRef.current = L.polyline([[segment.A.lat, segment.A.lng], [segment.B.lat, segment.B.lng]], { color: '#3fb950', weight: 4, opacity: 0.7 }).addTo(map);
    if (segment.foot && lat != null) {
      footOverlayRef.current = L.polyline([[segment.foot.lat, segment.foot.lng], [lat, lng]], { color: '#f85149', weight: 2, dashArray: '4 4' }).addTo(map);
    }
  }, [L, segment, lat, lng]);

  if (lat == null) return null;
  return <div ref={mapRef} className="map-container" aria-label="Location map" role="img" />;
}

// Diagnostic card for OSM-based side detection. Renders nothing when
// detection is null (e.g. no coords were sent or whichSide threw).
function SideDetectionCard({ detection }) {
  if (!detection) return null;
  const sideColor = detection.side === 'odd' ? '#d29922' : detection.side === 'even' ? '#3fb950' : '#8b949e';
  return (
    <div className="card">
      <h3>Side detection</h3>
      <Row label="Side" value={<strong style={{ color: sideColor }}>{detection.side?.toUpperCase() || 'UNKNOWN'}</strong>} />
      {detection.side === 'unknown' && detection.error && <Row label="Reason" value={detection.error} />}
      <Row label="Road" value={detection.road_name || '\u2014'} />
      <Row label="Offset from centerline" value={detection.perpendicular_offset_m != null ? `${detection.perpendicular_offset_m} m` : '\u2014'} />
      <Row label="Cross sign" value={String(detection.cross_sign)} />
      <Row label="Car-side house #" value={detection.car_house_number ?? '\u2014'} />
      <Row label="Opposite-side house #" value={detection.opposite_house_number ?? '\u2014'} />
      <Row label="OSM way id" value={detection.way_id ?? '\u2014'} />
    </div>
  );
}

function SweepResults({ data, vehicleName, fullAddr, lat, lng }) {
  if (!data?.found) return null;

  const sides = data.sweep_events?.length
    ? [...new Set(data.sweep_events.map(e => e.side))].map(s => s + ' side').join(' & ')
    : null;

  return (
    <>
      <StatusBox status={data.status} title={data.title} message={data.message} />
      {data.sweep_events?.length > 0 && (
        <div className="card">
          <h3>Upcoming Sweeping Events</h3>
          {data.sweep_events.slice(0, 8).map((evt, i) => {
            const yourSide = evt.side === 'both' || (data.car_side && evt.side === data.car_side);
            const evtDate = new Date(evt.date + 'T12:00:00');
            const todayMid = new Date(clientToday() + 'T12:00:00');
            const daysAway = Math.round((evtDate - todayMid) / 86400000);
            const daysLabel = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `${daysAway} days`;
            return (
              <div className={`event ${yourSide ? 'event-yours' : 'event-other'}`} key={i}>
                <span className="event-date">
                  {evtDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ({daysLabel})
                  {yourSide && <span className="event-badge">YOUR SIDE</span>}
                </span>
                <span className="event-side">{evt.side} side &middot; {evt.time}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="card">
        <h3>Details</h3>
        <Row label="Address" value={data.place_name || fullAddr || ''} />
        {data.car_side && <Row label="Your Side" value={`${data.car_side} (#${data.house_num})${data.side_source === 'osm' ? ' · OSM-verified' : data.side_source === 'house_parity' ? ' · estimated' : ''}`} />}
        {data.days_until_next != null && <Row label="Next Sweep" value={data.days_until_next === 0 ? 'Today' : data.days_until_next === 1 ? 'Tomorrow' : `In ${data.days_until_next} days`} />}
        {vehicleName && <Row label="Vehicle" value={vehicleName} />}
        {lat != null && <Row label="Coordinates" value={`${lat.toFixed(5)}, ${lng.toFixed(5)}`} />}
        {sides && <Row label="Sweeping Rules" value={`${sides} \u00B7 ${data.sweep_events[0]?.time}`} />}
        <Row label="Data Source" value="City of Somerville / Recollect" />
      </div>
    </>
  );
}

// Side-detection test panel. Draggable marker on a Leaflet map; on drop,
// hits POST /api/which-side and renders the algorithm's reasoning so we
// can validate the geometry against ground truth (e.g. drag pin to
// either curb of Harvard St, confirm the side flips).
function TestSidePanel() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const inflightRef = useRef(null);
  const [pos, setPos] = useState({ lat: 42.385081, lng: -71.107841 });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [L, setL] = useState(null);

  // Abort the in-flight probe before starting a new one — fast drags
  // would otherwise race and the last-resolving call (not the latest
  // pin position) wins, leaving the green segment overlay misaligned.
  const probe = useCallback(async (lat, lng) => {
    inflightRef.current?.abort();
    const ctrl = new AbortController();
    inflightRef.current = ctrl;
    setLoading(true); setError('');
    try {
      const r = await post('which-side', { lat, lng }, ctrl.signal);
      if (!ctrl.signal.aborted) setResult(r);
    } catch (e) {
      if (e.name !== 'AbortError') { setError(e.message); setResult(null); }
    }
    if (!ctrl.signal.aborted) setLoading(false);
  }, []);

  useEffect(() => { loadLeaflet().then(setL); }, []);

  useEffect(() => {
    if (!L || !mapRef.current || mapInstance.current) return;
    const m = L.map(mapRef.current).setView([pos.lat, pos.lng], 18);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(m);
    const mk = L.marker([pos.lat, pos.lng], { draggable: true }).addTo(m);
    mk.on('dragend', () => {
      const ll = mk.getLatLng();
      setPos({ lat: ll.lat, lng: ll.lng });
      probe(ll.lat, ll.lng);
    });
    mapInstance.current = m;
    probe(pos.lat, pos.lng);
    return () => {
      inflightRef.current?.abort();
      m.remove();
      mapInstance.current = null;
    };
  }, [L]);

  // Draw the chosen road segment + perpendicular foot whenever result updates.
  useEffect(() => {
    if (!L || !mapInstance.current || !result?.segment) return;
    const map = mapInstance.current;
    if (map._segOverlay) map.removeLayer(map._segOverlay);
    if (map._footOverlay) map.removeLayer(map._footOverlay);
    const seg = result.segment;
    if (seg?.A && seg?.B) {
      map._segOverlay = L.polyline([[seg.A.lat, seg.A.lng], [seg.B.lat, seg.B.lng]], { color: '#3fb950', weight: 4, opacity: 0.7 }).addTo(map);
    }
    if (seg?.foot && pos) {
      map._footOverlay = L.polyline([[seg.foot.lat, seg.foot.lng], [pos.lat, pos.lng]], { color: '#f85149', weight: 2, dashArray: '4 4' }).addTo(map);
    }
  }, [L, result, pos]);

  return (
    <div role="tabpanel">
      <p style={{ fontSize: '0.85rem', color: '#8b949e', marginBottom: 12 }}>
        Drag the pin to test side-detection. Green line = OSM road segment the algorithm picked.
        Red dashed line = perpendicular from pin to that segment.
      </p>
      <div ref={mapRef} className="map-container" style={{ height: 360 }} />
      <div className="card" style={{ marginTop: 12 }}>
        <h3>Detection Result {loading && <span style={{ fontSize: '0.7rem', color: '#8b949e' }}>(probing...)</span>}</h3>
        {error && <p style={{ color: '#f85149' }}>{error}</p>}
        {result && (
          <>
            <Row label="Side" value={
              <strong style={{ color: result.side === 'odd' ? '#d29922' : result.side === 'even' ? '#3fb950' : '#8b949e' }}>
                {result.side?.toUpperCase() || 'UNKNOWN'}
              </strong>
            } />
            {result.side === 'unknown' && result.error && <Row label="Reason" value={result.error} />}
            <Row label="Road" value={result.road_name} />
            <Row label="Offset from centerline" value={result.perpendicular_offset_m != null ? `${result.perpendicular_offset_m} m` : '—'} />
            <Row label="Cross sign" value={String(result.cross_sign)} />
            <Row label="Car-side house #" value={result.car_house_number ?? '—'} />
            <Row label="Opposite-side house #" value={result.opposite_house_number ?? '—'} />
            <Row label="Pin lat/lng" value={`${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`} />
            <Row label="OSM way id" value={result.way_id ?? '—'} />
          </>
        )}
      </div>
    </div>
  );
}

// sv-SE locale formats dates as YYYY-MM-DD natively in evergreen browsers.
function clientToday() { return new Date().toLocaleDateString('sv-SE'); }

// Accept either a raw slack user id (U060NLFUM) or a pasted slack URL
// (https://app.slack.com/team/U..., /user_profile/U..., slack://user?id=U...)
// and return the extracted U-id. Pass-through if input doesn't look URL-y.
function parseSlackInput(value) {
  const v = value.trim();
  if (!v.includes('/') && !v.includes('?')) return v;
  const m = v.match(/(?:\/(?:team|user_profile)\/|[?&]id=)(U[A-Z0-9]+)/);
  return m ? m[1] : v;
}

function NotificationsPanel({ slackUserId, setSlackUserId, enabledForThis, notifLoading, notifError, onSlackSignIn, onEnable, onDisable }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{'🔔'} Daily Slack Pings</h3>
      <p style={{ fontSize: '0.85rem', color: '#8b949e', marginBottom: 12 }}>
        Get a slack DM 1, 2, and 3 days before sweeping. Runs at 12pm ET daily; wakes the car briefly to read its location.
      </p>
      {enabledForThis ? (
        <>
          <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
            {'✅'} Enabled for <strong>{enabledForThis.vehicle_name}</strong> — DMs go to <code>{enabledForThis.slack_user_id}</code>
            {enabledForThis.last_check_at && <> · last check {new Date(enabledForThis.last_check_at).toLocaleString()}</>}
          </p>
          <button className="disconnect-btn" onClick={() => onDisable(enabledForThis.id)} disabled={notifLoading}>
            {notifLoading ? 'Disabling...' : 'Disable Notifications'}
          </button>
        </>
      ) : (
        <>
          {slackUserId ? (
            <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
              {'🔐'} Signed in as <code>{slackUserId}</code>. Click Enable to subscribe, or sign in as someone else.
            </p>
          ) : null}
          <button onClick={onSlackSignIn} disabled={notifLoading} style={{ marginBottom: 12 }}>
            {notifLoading ? 'Connecting to Slack...' : (slackUserId ? 'Switch slack account' : 'Sign in with Slack')}
          </button>
          <details style={{ marginBottom: 12 }} open={!slackUserId ? false : undefined}>
            <summary style={{ fontSize: '0.8rem', color: '#8b949e', cursor: 'pointer' }}>or paste your slack user id manually</summary>
            <label htmlFor="slack-user-id" style={{ marginTop: 8, display: 'block' }}>Slack User ID or Profile URL</label>
            <input
              id="slack-user-id"
              placeholder="U060NLFUM or paste your slack profile URL"
              value={slackUserId}
              onInput={e => setSlackUserId(parseSlackInput(e.target.value))}
            />
            <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: -8, marginBottom: 12 }}>
              Find via Slack profile → ⋮ → Copy member ID.
            </p>
          </details>
          <button onClick={onEnable} disabled={notifLoading || !slackUserId}>
            {notifLoading ? 'Enabling...' : `Enable Daily Notifications${slackUserId ? ` for ${slackUserId}` : ''}`}
          </button>
        </>
      )}
      {notifError && <p style={{ fontSize: '0.85rem', color: '#f85149', marginTop: 8 }}>{notifError}</p>}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const p = q.get('tab');
    if (['address', 'app', 'test'].includes(p)) return p;
    return q.get('address') ? 'address' : 'app';
  });
  // Persist active tab to URL — refresh/share preserves the view.
  // Drop ?tab=app since it's the default; keeps URLs clean.
  // Also drop ?address= when leaving the address tab — the param
  // belongs to that tab's flow only.
  useEffect(() => {
    const url = new URL(window.location);
    if (tab === 'app') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    if (tab !== 'address') url.searchParams.delete('address');
    window.history.replaceState({}, '', url);
  }, [tab]);
  // Clear results on tab switch — address tab and app tab share the
  // same sweepData/mapPos/vehicleInfo state, so without this the
  // address result bleeds into the app tab and vice-versa.
  useEffect(() => {
    setSweepData(null);
    setMapPos(null);
    setVehicleInfo(null);
  }, [tab]);
  const [loading, setLoading] = useState(false);
  // Sub-message shown under the loading state. Used to surface
  // "your car is asleep, waking it" after the first few seconds —
  // server holds the request up to 60s while polling Tesla's wake
  // endpoint, and a static "Checking..." button label is alarming
  // past ~5s.
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState('');
  const [sweepData, setSweepData] = useState(null);
  const [vehicleInfo, setVehicleInfo] = useState(null);
  const [vehicles, setVehicles] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(() => localStorage.getItem('tesla_selected_vehicle') || null);
  const [mapPos, setMapPos] = useState(null);
  const [oauthStatus, setOauthStatus] = useState('');
  const [tokens, setTokens] = useState(() => {
    try {
      const saved = localStorage.getItem('tesla_tokens');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  const [address, setAddress] = useState(() => new URLSearchParams(window.location.search).get('address') || '');

  const [slackUserId, setSlackUserId] = useState(() => localStorage.getItem('tesla_slack_user_id') || '');
  const [subscriptions, setSubscriptions] = useState(null);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState('');

  const refreshPromise = useRef(null);

  const autoCheckedRef = useRef(false);

  useEffect(() => {
    if (tokens) {
      localStorage.setItem('tesla_tokens', JSON.stringify(tokens));
      if (!vehicles) {
        fetchVehicles(tokens.access_token).then(vlist => {
          const vid = selectedVehicle || (vlist.length === 1 ? vlist[0].id : null);
          if (vid && !autoCheckedRef.current) {
            autoCheckedRef.current = true;
            // Hydrate from 6h cache if available — avoids waking the
            // car on every page open within the window.
            const cached = readCachedCheck(vid);
            if (cached) {
              setMapPos(cached.mapPos);
              setVehicleInfo(cached.vehicleInfo);
              setSweepData(cached.sweepData);
              return;
            }
            // No cache: only auto-check if the car is already online.
            // Avoids silently waking it on passive page loads. Manual
            // "Check My Car" still forces a wake-then-check.
            const v = vlist.find(x => x.id === vid);
            if (v?.state === 'online') {
              checkVehicle(tokens.access_token, vid).catch(() => {});
            }
          }
        }).catch(() => {});
      }
    } else {
      localStorage.removeItem('tesla_tokens');
      localStorage.removeItem(CHECK_CACHE_KEY);
    }
  }, [tokens]);

  useEffect(() => {
    if (selectedVehicle) localStorage.setItem('tesla_selected_vehicle', selectedVehicle);
    else localStorage.removeItem('tesla_selected_vehicle');
  }, [selectedVehicle]);

  useEffect(() => {
    if (slackUserId) localStorage.setItem('tesla_slack_user_id', slackUserId);
  }, [slackUserId]);

  useEffect(() => {
    if (tokens && slackUserId) fetchSubscriptions(slackUserId);
    // Key on the stable refresh_token string instead of the tokens
    // object — token refresh creates a new object every ~7h and we
    // don't need to re-fetch subs on each silent rotation.
  }, [tokens?.refresh_token, slackUserId]);

  const logout = () => {
    setTokens(null);
    setVehicles(null);
    setSelectedVehicle(null);
    setOauthStatus('');
    setSubscriptions(null);
    // Clear cached check directly — the localStorage useEffect only
    // runs when the value differs, and a stale `tesla_last_check`
    // would otherwise survive a logout/login cycle.
    try { localStorage.removeItem(CHECK_CACHE_KEY); } catch {}
    reset();
  };

  const fetchSubscriptions = async (uid) => {
    if (!uid) return;
    try {
      const data = await get(`notifications/status?slack_user_id=${encodeURIComponent(uid)}`);
      setSubscriptions(data.subscriptions || []);
    } catch (e) {
      console.warn('[fetchSubscriptions]', e.message);
    }
  };

  const enableNotifications = async () => {
    setNotifError('');
    if (!/^U[A-Z0-9]+$/.test(slackUserId)) {
      setNotifError('Slack user ID looks like U060NLFUM (Slack profile → ⋮ → Copy member ID)');
      return;
    }
    const vid = selectedVehicle || vehicles?.[0]?.id;
    if (!vid || !tokens?.refresh_token) { setNotifError('Need a connected vehicle first'); return; }
    setNotifLoading(true);
    try {
      const veh = vehicles.find(v => v.id === vid);
      const data = await post('notifications/enable', {
        refresh_token: tokens.refresh_token,
        vehicle_id: vid,
        vehicle_name: veh?.name || 'Unknown',
        slack_user_id: slackUserId,
      });
      await fetchSubscriptions(slackUserId);
      setNotifError('');
      const dmHint = data.test_dm_ok
        ? ' (check slack for the test ping)'
        : data.test_dm_error
          ? ` — couldn't send test DM (${data.test_dm_error}), sub still active`
          : '';
      setOauthStatus(`\u{1F514} Daily slack pings enabled for ${veh?.name || 'this vehicle'}${dmHint}`);
    } catch (e) {
      setNotifError(e.message);
    } finally {
      setNotifLoading(false);
    }
  };

  const disableNotifications = async (subId) => {
    setNotifLoading(true);
    setNotifError('');
    try {
      await post('notifications/disable', { id: subId, slack_user_id: slackUserId });
      await fetchSubscriptions(slackUserId);
    } catch (e) {
      setNotifError(e.message);
    } finally {
      setNotifLoading(false);
    }
  };

  const reset = () => {
    setError('');
    setSweepData(null);
    setVehicleInfo(null);
    setMapPos(null);
  };

  const refreshToken = useCallback(async () => {
    if (!tokens?.refresh_token) return false;
    if (refreshPromise.current) return refreshPromise.current;
    refreshPromise.current = (async () => {
      try {
        const data = await post('oauth/app/refresh', { refresh_token: tokens.refresh_token });
        const newTokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
        };
        setTokens(newTokens);
        setOauthStatus('\u2705 Token refreshed');
        return data.access_token;
      } catch (e) {
        setOauthStatus('\u274C Refresh failed: ' + e.message);
        setTokens(null);
        return false;
      } finally {
        refreshPromise.current = null;
      }
    })();
    return refreshPromise.current;
  }, [tokens]);

  useEffect(() => {
    if (!tokens) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, tokens.expires_at - Date.now());
      const mins = Math.floor(remaining / 60000);
      const hrs = Math.floor(mins / 60);
      if (remaining <= 0) {
        setOauthStatus('\u26A0\uFE0F Token expired. Refreshing...');
        refreshToken();
      } else if (hrs > 0) {
        setOauthStatus(`\u2705 Connected — token expires in ${hrs}h ${mins % 60}m`);
      } else {
        setOauthStatus(`\u2705 Connected — token expires in ${mins}m`);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [tokens, refreshToken]);

  const fetchVehicles = async (accessToken) => {
    const data = await post('vehicles', { token: accessToken });
    setVehicles(data.vehicles);
    if (data.vehicles.length === 1) setSelectedVehicle(data.vehicles[0].id);
    // Drop a stale selectedVehicle if the new list doesn't contain it —
    // happens after switching Tesla accounts. Otherwise the next
    // /api/check would 404/401 with the old id from another account.
    else if (selectedVehicle && !data.vehicles.some(v => v.id === selectedVehicle)) {
      setSelectedVehicle(null);
    }
    return data.vehicles;
  };

  const checkVehicle = async (accessToken, vehicleId) => {
    let vehicle;
    const body = { token: accessToken };
    if (vehicleId) body.vehicle_id = vehicleId;
    try {
      vehicle = await post('check', body);
    } catch (e) {
      if (e.message.includes('401') && tokens?.refresh_token) {
        const newToken = await refreshToken();
        if (newToken) vehicle = await post('check', { ...body, token: newToken });
        else throw e;
      } else throw e;
    }

    if (vehicle.no_vehicles) {
      setVehicles([]);
      setOauthStatus('\u2705 Connected — no vehicles on this account');
      return;
    }

    const geo = await post('reverse-geocode', { lat: vehicle.latitude, lng: vehicle.longitude });
    const mapPosVal = { lat: vehicle.latitude, lng: vehicle.longitude, street: geo.street || 'Unknown' };
    const vehicleInfoVal = { name: vehicle.vehicle_name, addr: geo.display_name };
    setMapPos(mapPosVal);
    setVehicleInfo(vehicleInfoVal);

    const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
    if (!addr) {
      const fallback = { found: true, status: 'info', title: 'Location Found', message: `Car at ${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)} but couldn't determine street.`, sweep_events: [] };
      setSweepData(fallback);
      saveCachedCheck(vehicleId, { mapPos: mapPosVal, vehicleInfo: vehicleInfoVal, sweepData: fallback });
      return;
    }

    const data = await post('sweep-check', { address: addr, today_date: clientToday(), past_noon: new Date().getHours() >= 12, lat: vehicle.latitude, lng: vehicle.longitude });
    if (data.found) {
      setSweepData(data);
      saveCachedCheck(vehicleId, { mapPos: mapPosVal, vehicleInfo: vehicleInfoVal, sweepData: data });
    } else {
      setError(`"${addr}" not in Somerville sweeping database.`);
    }
  };

  const handleCheckAddress = async () => {
    if (!address.trim()) { setError('Please enter an address'); return; }
    if (loading) return;
    reset();
    setLoading(true);
    try {
      const data = await post('sweep-check', { address: address.trim(), today_date: clientToday(), past_noon: new Date().getHours() >= 12 });
      if (!data.found) { setError(data.message); return; }
      setSweepData(data);
      if (data.latitude && data.longitude) {
        setMapPos({ lat: data.latitude, lng: data.longitude, street: data.place_name });
      } else {
        // No coords from server — clear any stale map from a prior
        // successful query so the user doesn't see a wrong-address pin.
        setMapPos(null);
      }
      const url = new URL(window.location);
      url.searchParams.set('address', address.trim());
      window.history.replaceState({}, '', url);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleCheckCar = async (vid) => {
    if (!tokens?.access_token) return;
    if (loading) return;
    reset();
    setLoading(true);
    // 7s after start, assume the car was asleep and the server is in
    // its wake-and-poll loop. Switch the UI to "Waking..." so the user
    // knows the next ~30-50s of latency is expected, not a hang.
    const wakeHint = setTimeout(() => setWaking(true), 7000);
    try { await checkVehicle(tokens.access_token, vid || selectedVehicle); }
    catch (e) { setError(e.message); }
    finally {
      clearTimeout(wakeHint);
      setWaking(false);
      setLoading(false);
    }
  };

  const connectTesla = async () => {
    setLoading(true);
    setOauthStatus('Redirecting to Tesla...');
    try {
      const data = await post('oauth/app/start', {});
      sessionStorage.setItem('tesla_oauth_state', data.state);
      window.location.href = data.url;
    } catch (e) {
      setError('Failed to start OAuth: ' + e.message);
      setLoading(false);
      setOauthStatus('');
    }
  };

  const handleSlackSignIn = async () => {
    setNotifError('');
    setNotifLoading(true);
    try {
      const data = await post('slack/oauth/start', {});
      sessionStorage.setItem('slack_oauth_state', data.state);
      window.location.href = data.url;
    } catch (e) {
      setNotifError('Slack sign-in failed to start: ' + e.message);
      setNotifLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) return;

    // Strip just the OAuth params, preserve user-meaningful ones (tab, address).
    const cleaned = new URL(window.location);
    cleaned.searchParams.delete('code');
    cleaned.searchParams.delete('state');
    window.history.replaceState({}, '', cleaned);

    const slackState = sessionStorage.getItem('slack_oauth_state');
    const teslaState = sessionStorage.getItem('tesla_oauth_state');

    if (slackState && state === slackState) {
      sessionStorage.removeItem('slack_oauth_state');
      setOauthStatus('Exchanging slack code for identity...');
      setNotifLoading(true);
      post('slack/oauth/callback', { code })
        .then(data => {
          if (!data.slack_user_id) throw new Error('Slack returned no user_id');
          setSlackUserId(data.slack_user_id);
          setNotifError('');
          setOauthStatus(`\u{1F510} Signed in as ${data.name || data.slack_user_id} — click Enable Daily Notifications to subscribe.`);
        })
        .catch(e => {
          setNotifError('Slack sign-in failed: ' + e.message);
          setOauthStatus('❌ Slack sign-in failed: ' + e.message);
        })
        .finally(() => setNotifLoading(false));
      return;
    }

    if (!teslaState || state !== teslaState) {
      setError(`OAuth state mismatch (slack=${!!slackState}, tesla=${!!teslaState}). Try again.`);
      return;
    }

    setOauthStatus('Exchanging code for token...');
    setLoading(true);
    setTab('app');

    post('oauth/app/callback', { code })
      .then(async (data) => {
        setTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 });
        setOauthStatus('\u2705 Connected! Loading vehicles...');
        const vlist = await fetchVehicles(data.access_token);
        if (vlist.length === 0) {
          setOauthStatus('\u2705 Connected — no vehicles on this account');
        } else if (vlist.length === 1) {
          // Just-completed OAuth: user opted in by going through the
          // login UX, so it's reasonable to wake the car here even if
          // asleep. The other auto-check (tokens-loaded effect) stays
          // gated on state==online so subsequent passive page loads
          // don't drain the battery.
          if (vlist[0].state !== 'online') setWaking(true);
          setOauthStatus(vlist[0].state === 'online'
            ? '\u2705 Connected! Checking your car...'
            : '\u2705 Connected \u2014 waking your car (up to 60s)...');
          try { await checkVehicle(data.access_token, vlist[0].id); }
          finally { setWaking(false); }
        } else {
          setOauthStatus(`\u2705 Connected — ${vlist.length} vehicles found. Select one to check.`);
        }
      })
      .catch(e => setOauthStatus('\u274C ' + e.message))
      .finally(() => {
        sessionStorage.removeItem('tesla_oauth_state');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (address && new URLSearchParams(window.location.search).get('address')) {
      handleCheckAddress();
    }
  }, []);

  const tabs = [
    { id: 'address', icon: '\uD83D\uDCCD', label: 'Address' },
    { id: 'app', icon: '\uD83D\uDE97', label: 'Tesla Login' },
    { id: 'test', icon: '\uD83E\uDDEA', label: 'Test Side' },
  ];

  return (
    <div className="container">
      <h1>{'\uD83D\uDE97'} Tesla Sweeper</h1>
      <p className="subtitle">Check if your car needs to move for Somerville street sweeping</p>

      <div className="tabs" role="tablist">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'address' && (
        <div role="tabpanel">
          <label htmlFor="address">Street Address in Somerville</label>
          <input id="address" placeholder="e.g. 11 Harvard St" value={address} onInput={e => setAddress(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCheckAddress()} autoComplete="street-address" autoCapitalize="words" enterKeyHint="search" />
          <button onClick={handleCheckAddress} disabled={loading}>{loading ? 'Checking...' : 'Check Sweeping Schedule'}</button>
        </div>
      )}

      {tab === 'app' && (
        <div role="tabpanel">
          {tokens ? (
            <>
              <div className="oauth-status">{oauthStatus || '\u2705 Connected'}</div>
              {vehicles && vehicles.length === 0 && (
                <p style={{fontSize: '0.85rem', color: '#8b949e', marginBottom: 16}}>No vehicles registered on this Tesla account. Add a vehicle in the Tesla app and try again.</p>
              )}
              {vehicles && vehicles.length > 1 && (
                <div style={{marginBottom: 16}}>
                  <label>Select Vehicle</label>
                  <select value={selectedVehicle || ''} onChange={e => setSelectedVehicle(e.target.value)} style={{width: '100%', padding: '10px 12px', background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#c9d1d9', fontSize: '0.9rem'}}>
                    <option value="" disabled>Choose a vehicle...</option>
                    {vehicles.map(v => <option key={v.id} value={v.id}>{v.name} ({v.state})</option>)}
                  </select>
                </div>
              )}
              {vehicles && vehicles.length > 0 && (
                <button onClick={() => handleCheckCar(selectedVehicle)} disabled={loading || (vehicles.length > 1 && !selectedVehicle)}>{loading ? (waking ? 'Waking your car... (up to 60s)' : 'Checking...') : 'Check My Car'}</button>
              )}
              {vehicles && vehicles.length > 0 && (
                <NotificationsPanel
                  slackUserId={slackUserId}
                  setSlackUserId={setSlackUserId}
                  enabledForThis={subscriptions?.find(s => s.vehicle_id === (selectedVehicle || vehicles[0].id))}
                  notifLoading={notifLoading}
                  notifError={notifError}
                  onSlackSignIn={handleSlackSignIn}
                  onEnable={enableNotifications}
                  onDisable={disableNotifications}
                />
              )}
              <button className="disconnect-btn" onClick={logout}>Disconnect</button>
            </>
          ) : (
            <>
              <p style={{fontSize: '0.85rem', color: '#8b949e', marginBottom: 16}}>Sign in with your Tesla account to locate your car and check the sweeping schedule.</p>
              <button onClick={connectTesla} disabled={loading}>{loading ? 'Connecting...' : 'Connect Tesla Account'}</button>
              {oauthStatus && <div className="oauth-status">{oauthStatus}</div>}
            </>
          )}
        </div>
      )}

      {tab === 'test' && <TestSidePanel />}

      {error && (
        <div className="error-box" role="alert">
          <p className="error">{error}</p>
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">&times;</button>
        </div>
      )}
      {(tab === 'address' || tab === 'app') && <>
        <MapView lat={mapPos?.lat} lng={mapPos?.lng} street={mapPos?.street} />
        <SweepResults data={sweepData} vehicleName={vehicleInfo?.name} fullAddr={vehicleInfo?.addr} lat={mapPos?.lat} lng={mapPos?.lng} />
      </>}

      <footer>
        Somerville sweeping: Apr 1 – Dec 31 &middot; Data from Recollect/City of Somerville &middot; Always check street signs
        <br /><a href="https://github.com/VoX/tesla-sweeper">GitHub</a>
      </footer>
    </div>
  );
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

const API = import.meta.env.DEV ? '/sweeper/api' : 'api';

// Cache successful vehicle checks for 6h so subsequent page loads
// hydrate from localStorage instead of waking the car. The "Check My
// Car" button still bypasses cache when the user wants fresh data.
const CHECK_CACHE_MS = 6 * 60 * 60 * 1000;
const CHECK_CACHE_KEY = 'tesla_last_check';
function readCachedCheck(vehicleId) {
  if (!vehicleId) return null;
  try {
    const c = JSON.parse(localStorage.getItem(CHECK_CACHE_KEY));
    if (!c || c.vehicle_id !== vehicleId) return null;
    if (Date.now() - c.at > CHECK_CACHE_MS) return null;
    return c;
  } catch { return null; }
}
function saveCachedCheck(vehicleId, payload) {
  if (!vehicleId) return;
  try {
    localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({
      vehicle_id: vehicleId, at: Date.now(), ...payload,
    }));
  } catch {}
}

async function post(url, body) {
  const res = await fetch(`${API}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: 'API error' }));
    throw new Error(e.detail || 'API error');
  }
  return res.json();
}

function StatusBox({ status, title, message }) {
  const icon = { danger: '\u{1F6A8}', warning: '\u26A0\uFE0F', safe: '\u2705', info: '\u2139\uFE0F' }[status] || '';
  return (
    <div className={`status-box ${status}`}>
      <h2>{icon} {title}</h2>
      <p>{message}</p>
    </div>
  );
}

function Row({ label, value }) {
  return <div className="row"><span className="label">{label}</span><span>{value}</span></div>;
}

function MapView({ lat, lng, street }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; markerRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || lat == null) return;
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '\u00A9 OpenStreetMap' }).addTo(mapInstance.current);
      markerRef.current = L.marker([lat, lng]).addTo(mapInstance.current);
    } else {
      mapInstance.current.setView([lat, lng], 17);
      markerRef.current.setLatLng([lat, lng]);
    }
    const popup = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = 'Your Car';
    popup.appendChild(b);
    popup.appendChild(document.createElement('br'));
    popup.appendChild(document.createTextNode(street || 'Unknown'));
    markerRef.current.bindPopup(popup).openPopup();
  }, [lat, lng, street]);

  if (lat == null) return null;
  return <div ref={mapRef} className="map-container" aria-label="Vehicle location map" role="img" />;
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
            const yourSide = data.car_side && (evt.side === data.car_side || evt.side === 'both');
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
        {data.car_side && <Row label="Your Side" value={`${data.car_side} (#${data.house_num})`} />}
        {data.days_until_next != null && <Row label="Next Sweep" value={data.days_until_next === 0 ? 'Today' : data.days_until_next === 1 ? 'Tomorrow' : `In ${data.days_until_next} days`} />}
        {vehicleName && <Row label="Vehicle" value={vehicleName} />}
        {lat != null && <Row label="Coordinates" value={`${lat.toFixed(5)}, ${lng.toFixed(5)}`} />}
        {sides && <Row label="Sweeping Rules" value={`${sides} \u00B7 ${data.sweep_events[0]?.time}`} />}
        <Row label="Data Source" value="City of Somerville / Recollect" />
      </div>
    </>
  );
}

function clientToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function NotificationsPanel({ slackUserId, setSlackUserId, enabledForThis, notifLoading, notifError, onEnable, onDisable }) {
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
          <label htmlFor="slack-user-id">Slack User ID</label>
          <input
            id="slack-user-id"
            placeholder="U060NLFUM"
            value={slackUserId}
            onChange={e => setSlackUserId(e.target.value.trim())}
          />
          <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: -8, marginBottom: 12 }}>
            In Slack: profile → ⋮ menu → Copy member ID
          </p>
          <button onClick={onEnable} disabled={notifLoading || !slackUserId}>
            {notifLoading ? 'Enabling...' : 'Enable Daily Notifications'}
          </button>
        </>
      )}
      {notifError && <p style={{ fontSize: '0.85rem', color: '#f85149', marginTop: 8 }}>{notifError}</p>}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('tab');
    if (['address', 'app', 'oauth'].includes(p)) return p;
    return new URLSearchParams(window.location.search).get('address') ? 'address' : 'app';
  });
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
  const autoLookupDone = useRef(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(() => window.location.href.split('?')[0].split('#')[0]);
  const [registerPartner, setRegisterPartner] = useState(false);

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
  }, [tokens, slackUserId]);

  const logout = () => {
    setTokens(null);
    setVehicles(null);
    setSelectedVehicle(null);
    setOauthStatus('');
    setSubscriptions(null);
    reset();
  };

  const fetchSubscriptions = async (uid) => {
    if (!uid) return;
    try {
      const res = await fetch(`${API}/notifications/status?slack_user_id=${encodeURIComponent(uid)}`);
      if (!res.ok) return;
      const data = await res.json();
      setSubscriptions(data.subscriptions || []);
    } catch {}
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
        oauth_mode: tokens.oauth_mode,
        client_id: tokens.client_id,
        vehicle_id: vid,
        vehicle_name: veh?.name || 'Unknown',
        slack_user_id: slackUserId,
      });
      await fetchSubscriptions(slackUserId);
      setNotifError('');
      setOauthStatus(`\u{1F514} Daily slack pings enabled for ${veh?.name || 'this vehicle'}`);
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
        const refreshUrl = tokens.oauth_mode === 'app' ? 'oauth/app/refresh' : 'oauth/refresh';
        const refreshBody = tokens.oauth_mode === 'app'
          ? { refresh_token: tokens.refresh_token }
          : { client_id: tokens.client_id, refresh_token: tokens.refresh_token };
        const data = await post(refreshUrl, refreshBody);
        const newTokens = {
          ...tokens,
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

    const data = await post('sweep-check', { address: addr, today_date: clientToday(), past_noon: new Date().getHours() >= 12 });
    if (data.found) {
      setSweepData(data);
      saveCachedCheck(vehicleId, { mapPos: mapPosVal, vehicleInfo: vehicleInfoVal, sweepData: data });
    } else {
      setError(`"${addr}" not in Somerville sweeping database.`);
    }
  };

  const handleCheckAddress = async () => {
    if (!address.trim()) { setError('Please enter an address'); return; }
    reset();
    setLoading(true);
    try {
      const data = await post('sweep-check', { address: address.trim(), today_date: clientToday(), past_noon: new Date().getHours() >= 12 });
      if (!data.found) { setError(data.message); return; }
      setSweepData(data);
      if (data.latitude && data.longitude) {
        setMapPos({ lat: data.latitude, lng: data.longitude, street: data.place_name });
      }
      const url = new URL(window.location);
      url.searchParams.set('address', address.trim());
      window.history.replaceState({}, '', url);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleCheckCar = async (vid) => {
    if (!tokens?.access_token) return;
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

  const handleOAuthStart = async () => {
    if (!clientId || !clientSecret) { setError('Client ID and Secret are required'); return; }
    sessionStorage.setItem('tesla_client_id', clientId);
    sessionStorage.setItem('tesla_client_secret', clientSecret);
    sessionStorage.setItem('tesla_redirect_uri', redirectUri);
    setLoading(true);
    setOauthStatus(registerPartner ? 'Registering with Tesla Fleet API...' : 'Redirecting to Tesla...');
    try {
      const data = await post('oauth/start', { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, register: registerPartner });
      sessionStorage.setItem('tesla_oauth_state', data.state);
      window.location.href = data.url;
    } catch (e) {
      setError('Failed to start OAuth: ' + e.message);
      setLoading(false);
      setOauthStatus('');
    }
  };

  const handleAppOAuthStart = async () => {
    setLoading(true);
    setOauthStatus('Redirecting to Tesla...');
    try {
      const data = await post('oauth/app/start', {});
      sessionStorage.setItem('tesla_oauth_state', data.state);
      sessionStorage.setItem('tesla_oauth_mode', 'app');
      window.location.href = data.url;
    } catch (e) {
      setError('Failed to start OAuth: ' + e.message);
      setLoading(false);
      setOauthStatus('');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) return;

    window.history.replaceState({}, '', window.location.pathname);

    const savedState = sessionStorage.getItem('tesla_oauth_state');
    if (!state || !savedState || state !== savedState) {
      setError('OAuth state mismatch — possible CSRF. Try again.');
      return;
    }

    const mode = sessionStorage.getItem('tesla_oauth_mode') || 'custom';
    const isApp = mode === 'app';

    setOauthStatus('Exchanging code for token...');
    setLoading(true);
    setTab(isApp ? 'app' : 'oauth');

    const callbackUrl = isApp ? 'oauth/app/callback' : 'oauth/callback';
    const callbackBody = isApp
      ? { code }
      : (() => {
          const cId = sessionStorage.getItem('tesla_client_id');
          const cSecret = sessionStorage.getItem('tesla_client_secret');
          const rUri = sessionStorage.getItem('tesla_redirect_uri');
          if (!cId || !cSecret) { setError('Missing OAuth credentials. Start the flow again.'); setLoading(false); return null; }
          return { client_id: cId, client_secret: cSecret, redirect_uri: rUri, code };
        })();

    if (!callbackBody) return;

    post(callbackUrl, callbackBody)
      .then(async (data) => {
        const tokenClientId = isApp ? 'app' : sessionStorage.getItem('tesla_client_id');
        setTokens({ access_token: data.access_token, refresh_token: data.refresh_token, client_id: tokenClientId, oauth_mode: mode, expires_at: Date.now() + data.expires_in * 1000 });
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
        ['tesla_client_id', 'tesla_client_secret', 'tesla_redirect_uri', 'tesla_oauth_state'].forEach(k => sessionStorage.removeItem(k));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (autoLookupDone.current || !address) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('address')) {
      autoLookupDone.current = true;
      handleCheckAddress();
    }
  }, []);

  const tabs = [
    { id: 'address', icon: '\uD83D\uDCCD', label: 'Address' },
    { id: 'app', icon: '\uD83D\uDE97', label: 'Tesla Login' },
    { id: 'oauth', icon: '\uD83D\uDD10', label: 'Custom OAuth' },
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
          <input id="address" placeholder="e.g. 11 Harvard St" value={address} onChange={e => setAddress(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCheckAddress()} />
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
                  onEnable={enableNotifications}
                  onDisable={disableNotifications}
                />
              )}
              <button className="disconnect-btn" onClick={logout}>Disconnect</button>
            </>
          ) : (
            <>
              <p style={{fontSize: '0.85rem', color: '#8b949e', marginBottom: 16}}>Sign in with your Tesla account to locate your car and check the sweeping schedule.</p>
              <button onClick={handleAppOAuthStart} disabled={loading}>{loading ? 'Connecting...' : 'Connect Tesla Account'}</button>
              {oauthStatus && <div className="oauth-status">{oauthStatus}</div>}
            </>
          )}
        </div>
      )}

      {tab === 'oauth' && (
        <div role="tabpanel">
          {tokens ? (
            <>
              <div className="oauth-status">{oauthStatus || '\u2705 Connected'}</div>
              <button onClick={handleCheckCar} disabled={loading}>{loading ? (waking ? 'Waking your car... (up to 60s)' : 'Checking...') : 'Check My Car'}</button>
              <button className="disconnect-btn" onClick={logout}>Disconnect</button>
            </>
          ) : (
            <>
              <div className="oauth-instructions">
                <p>Use your own Tesla developer app credentials:</p>
                <ol>
                  <li>Go to <a href="https://developer.tesla.com/dashboard" target="_blank" rel="noopener">developer.tesla.com/dashboard</a></li>
                  <li>Create an application (or use an existing one)</li>
                  <li>Enable scopes: <strong>Vehicle Information</strong> and <strong>Vehicle Location</strong></li>
                  <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong></li>
                  <li>Add <code>{redirectUri}</code> as an allowed Redirect URI in your app settings</li>
                </ol>
              </div>
              <label htmlFor="oauth-client-id">Tesla App Client ID</label>
              <input id="oauth-client-id" placeholder="From developer.tesla.com" value={clientId} onChange={e => setClientId(e.target.value)} />
              <label htmlFor="oauth-client-secret">Client Secret</label>
              <input id="oauth-client-secret" type="password" placeholder="Your app's client secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
              <label htmlFor="oauth-redirect">Redirect URI</label>
              <input id="oauth-redirect" placeholder="e.g. https://claw.bitvox.me/sweeper/" value={redirectUri} onChange={e => setRedirectUri(e.target.value)} />
              <label className="checkbox-label">
                <input type="checkbox" checked={registerPartner} onChange={e => setRegisterPartner(e.target.checked)} />
                Register app with Tesla Fleet API (first-time setup)
              </label>
              <button onClick={handleOAuthStart} disabled={loading}>{loading ? 'Connecting...' : 'Connect Tesla Account'}</button>
            </>
          )}
          {!tokens && oauthStatus && <div className="oauth-status">{oauthStatus}</div>}
        </div>
      )}

      {error && (
        <div className="error-box">
          <p className="error">{error}</p>
          <button className="error-dismiss" onClick={() => setError('')}>&times;</button>
        </div>
      )}
      <MapView lat={mapPos?.lat} lng={mapPos?.lng} street={mapPos?.street} />
      <SweepResults data={sweepData} vehicleName={vehicleInfo?.name} fullAddr={vehicleInfo?.addr} lat={mapPos?.lat} lng={mapPos?.lng} />

      <footer>
        Somerville sweeping: Apr 1 – Dec 31 &middot; Data from Recollect/City of Somerville &middot; Always check street signs
        <br /><a href="https://github.com/VoX/tesla-sweeper">GitHub</a>
      </footer>
    </div>
  );
}

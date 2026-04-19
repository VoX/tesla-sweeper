import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const API = import.meta.env.DEV ? '/sweeper/api' : 'api';

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
    if (!mapRef.current || lat == null) return;
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '\u00A9 OpenStreetMap',
      }).addTo(mapInstance.current);
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

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
        markerRef.current = null;
      }
    };
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
          {data.sweep_events.slice(0, 8).map((evt, i) => (
            <div className="event" key={i}>
              <span className="event-date">
                {new Date(evt.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="event-side">{evt.side} side &middot; {evt.time}</span>
            </div>
          ))}
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

export default function App() {
  const [tab, setTab] = useState('address');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sweepData, setSweepData] = useState(null);
  const [vehicleInfo, setVehicleInfo] = useState(null);
  const [mapPos, setMapPos] = useState(null);
  const [oauthStatus, setOauthStatus] = useState('');
  const [tokens, setTokens] = useState(null);

  const [address, setAddress] = useState(() => new URLSearchParams(window.location.search).get('address') || '');
  const autoLookupDone = useRef(false);
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(() => window.location.href.split('?')[0].split('#')[0]);

  const refreshPromise = useRef(null);

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
        const data = await post('oauth/refresh', {
          client_id: tokens.client_id,
          client_secret: tokens.client_secret,
          refresh_token: tokens.refresh_token,
        });
        const newTokens = {
          ...tokens,
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
        };
        setTokens(newTokens);
        setToken(data.access_token);
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

  const checkVehicle = async (accessToken) => {
    let vehicle;
    try {
      vehicle = await post('check', { token: accessToken });
    } catch (e) {
      if (e.message.includes('401') && tokens?.refresh_token) {
        const newToken = await refreshToken();
        if (newToken) vehicle = await post('check', { token: newToken });
        else throw e;
      } else throw e;
    }

    const geo = await post('reverse-geocode', { lat: vehicle.latitude, lng: vehicle.longitude });
    setMapPos({ lat: vehicle.latitude, lng: vehicle.longitude, street: geo.street || 'Unknown' });
    setVehicleInfo({ name: vehicle.vehicle_name, addr: geo.display_name });

    const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
    if (!addr) {
      setSweepData({ found: true, status: 'info', title: 'Location Found', message: `Car at ${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)} but couldn't determine street.`, sweep_events: [] });
      return;
    }

    const data = await post('sweep-check', { address: addr, today_date: clientToday() });
    if (data.found) setSweepData(data);
    else setError(`"${addr}" not in Somerville sweeping database.`);
  };

  const handleCheckAddress = async () => {
    if (!address.trim()) { setError('Please enter an address'); return; }
    reset();
    setLoading(true);
    try {
      const data = await post('sweep-check', { address: address.trim(), today_date: clientToday() });
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

  const handleCheckTesla = async () => {
    if (!token.trim()) { setError('Please enter your Tesla bearer token'); return; }
    reset();
    setLoading(true);
    try { await checkVehicle(token.trim()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleOAuthStart = async () => {
    if (!clientId || !clientSecret) { setError('Client ID and Secret are required'); return; }
    const uri = redirectUri || window.location.href.split('?')[0];
    sessionStorage.setItem('tesla_client_id', clientId);
    sessionStorage.setItem('tesla_client_secret', clientSecret);
    sessionStorage.setItem('tesla_redirect_uri', uri);
    setLoading(true);
    setOauthStatus('Redirecting to Tesla...');
    try {
      const data = await post('oauth/start', { client_id: clientId, redirect_uri: uri });
      sessionStorage.setItem('tesla_oauth_state', data.state);
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

    const cId = sessionStorage.getItem('tesla_client_id');
    const cSecret = sessionStorage.getItem('tesla_client_secret');
    const rUri = sessionStorage.getItem('tesla_redirect_uri');
    if (!cId || !cSecret) { setError('Missing OAuth credentials. Start the flow again.'); return; }

    setTab('oauth');
    setOauthStatus('Exchanging code for token...');
    setLoading(true);

    post('oauth/callback', { client_id: cId, client_secret: cSecret, redirect_uri: rUri, code })
      .then(async (data) => {
        setTokens({ access_token: data.access_token, refresh_token: data.refresh_token, client_id: cId, client_secret: cSecret, expires_at: Date.now() + data.expires_in * 1000 });
        setToken(data.access_token);
        setOauthStatus('\u2705 Connected! Checking your car...');
        ['tesla_client_id', 'tesla_client_secret', 'tesla_redirect_uri', 'tesla_oauth_state'].forEach(k => sessionStorage.removeItem(k));
        await checkVehicle(data.access_token);
      })
      .catch(e => {
        setOauthStatus('\u274C ' + e.message);
        ['tesla_client_id', 'tesla_client_secret', 'tesla_redirect_uri', 'tesla_oauth_state'].forEach(k => sessionStorage.removeItem(k));
      })
      .finally(() => setLoading(false));
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
    { id: 'oauth', icon: '\uD83D\uDD10', label: 'Tesla OAuth' },
    { id: 'tesla', icon: '\uD83D\uDD11', label: 'Bearer Token' },
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

      {tab === 'oauth' && (
        <div role="tabpanel">
          <label htmlFor="oauth-client-id">Tesla App Client ID</label>
          <input id="oauth-client-id" placeholder="From developer.tesla.com" value={clientId} onChange={e => setClientId(e.target.value)} />
          <label htmlFor="oauth-client-secret">Client Secret</label>
          <input id="oauth-client-secret" type="password" placeholder="Your app's client secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
          <label htmlFor="oauth-redirect">Redirect URI</label>
          <input id="oauth-redirect" placeholder="e.g. https://claw.bitvox.me/sweeper/" value={redirectUri} onChange={e => setRedirectUri(e.target.value)} />
          <button onClick={handleOAuthStart} disabled={loading}>{loading ? 'Connecting...' : 'Connect Tesla Account'}</button>
          {oauthStatus && <div className="oauth-status">{oauthStatus}</div>}
        </div>
      )}

      {tab === 'tesla' && (
        <div role="tabpanel">
          <label htmlFor="token">Tesla API Bearer Token</label>
          <input id="token" type="password" placeholder="Paste your Tesla bearer token..." value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCheckTesla()} />
          <button onClick={handleCheckTesla} disabled={loading}>{loading ? 'Checking...' : 'Check My Car'}</button>
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

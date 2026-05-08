import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { readCachedCheck, saveCachedCheck, clearCachedCheck } from './lib/cache.js';
import { post, get } from './lib/api.js';
import { clientToday } from './lib/date.js';
import { LocationResultsView } from './components/LocationResultsView.jsx';
import { NotificationsPanel } from './components/NotificationsPanel.jsx';

const TABS = [
  { id: 'app', icon: '🚗', label: 'Tesla Login' },
  { id: 'manual', icon: '🗺️', label: 'Manual' },
];

export default function App() {
  const [tab, setTab] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('tab');
    return p === 'manual' ? 'manual' : 'app';
  });
  // Persist active tab to URL — refresh/share preserves the view.
  // Drop ?tab=app since it's the default; keeps URLs clean.
  useEffect(() => {
    const url = new URL(window.location);
    if (tab === 'app') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url);
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
  // Transient toast layered over oauthStatus so the 60s tick effect
  // can keep refreshing the steady-state connection string without
  // wiping action toasts ("token refreshed", "slack pings enabled").
  // Auto-clears after 5s.
  const [transientToast, setTransientToast] = useState('');
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    clearTimeout(toastTimerRef.current);
    setTransientToast(msg);
    toastTimerRef.current = setTimeout(() => setTransientToast(''), 5000);
  }, []);
  const [tokens, setTokens] = useState(() => {
    try {
      const saved = localStorage.getItem('tesla_tokens');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  // Manual tab state — drag-to-set location, sweep + side detection
  // re-fetched on each pin move. Default centered on Somerville.
  const [manualPos, setManualPos] = useState({ lat: 42.385081, lng: -71.107841, street: 'Drag the pin to test' });
  const [manualSweepData, setManualSweepData] = useState(null);
  const [manualLoading, setManualLoading] = useState(false);
  const manualInflightRef = useRef(null);

  // Abort any in-flight manual probe on tab switch so its result
  // doesn't land into a tab you've left. The tabs use disjoint state
  // (app: sweepData/mapPos/vehicleInfo, manual: manualSweepData/
  // manualPos) so cross-tab cached results are fine to preserve —
  // returning to a tab you already loaded just shows the prior view
  // instead of forcing a re-check.
  useEffect(() => {
    manualInflightRef.current?.abort();
  }, [tab]);

  const [slackUserId, setSlackUserId] = useState(() => localStorage.getItem('tesla_slack_user_id') || '');
  const [subscriptions, setSubscriptions] = useState(null);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState('');

  const refreshPromise = useRef(null);

  const autoCheckedRef = useRef(false);

  // Geo response → "{house_number} {street}" with empty parts dropped.
  // Both the Tesla and manual flows hit /reverse-geocode and need the
  // same formatted address for /sweep-check.
  const addrFromGeo = (geo) => [geo.house_number, geo.street].filter(Boolean).join(' ');
  // Slack session token (HMAC paired with slack_user_id) used to prove
  // ownership on /enable + /disable; empty string when not signed in.
  const slackSession = () => sessionStorage.getItem('slack_session') || '';

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
      clearCachedCheck();
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
    clearCachedCheck();
    reset();
  };

  const fetchSubscriptions = async (uid) => {
    if (!uid) return;
    const data = await get(`notifications/status?slack_user_id=${encodeURIComponent(uid)}`)
      .catch(() => ({ subscriptions: [] }));
    setSubscriptions(data.subscriptions || []);
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
        session: slackSession(),
      });
      await fetchSubscriptions(slackUserId);
      setNotifError('');
      const dmHint = data.test_dm_ok
        ? ' (check slack for the test ping)'
        : data.test_dm_error
          ? ` — couldn't send test DM (${data.test_dm_error}), sub still active`
          : '';
      showToast(`\u{1F514} Daily slack pings enabled for ${veh?.name || 'this vehicle'}${dmHint}`);
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
      await post('notifications/disable', { id: subId, slack_user_id: slackUserId, session: slackSession() });
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
        showToast('\u2705 Token refreshed');
        return data.access_token;
      } catch (e) {
        showToast('\u274C Refresh failed: ' + e.message);
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
    const check = () => {
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
    };
    // Eager run so an already-expired token on mount kicks off a
    // refresh immediately instead of waiting up to 60s for the first
    // setInterval tick.
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, [tokens, refreshToken]);

  const fetchVehicles = async (accessToken) => {
    let data;
    try {
      data = await post('vehicles', { token: accessToken });
    } catch (e) {
      // Match checkVehicle's pattern: a 401 on a stale-load means the
      // token expired since last visit; refresh + retry once before
      // bubbling up. Without this, the page sat on a failed /vehicles
      // until the 60s setInterval polling tick eventually triggered
      // the refresh on its own.
      if (e.status === 401 && tokens?.refresh_token) {
        const newToken = await refreshToken();
        if (newToken) data = await post('vehicles', { token: newToken });
        else throw e;
      } else throw e;
    }
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
      if (e.status === 401 && tokens?.refresh_token) {
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

    const addr = addrFromGeo(geo);
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

  // 300ms trailing debounce so a flurry of drag-releases (drag, drop,
  // re-drag) collapses into one server round-trip. AbortController
  // already cancels in-flight requests; this just stops us from
  // queueing them in the first place. Auto-probe on tab switch
  // (line below the useCallback) bypasses the debounce on purpose.
  const pinDebounceRef = useRef(null);
  const debouncedPinMove = useCallback((lat, lng) => {
    clearTimeout(pinDebounceRef.current);
    pinDebounceRef.current = setTimeout(() => handleManualPinMove(lat, lng), 300);
  }, []);

  // Manual-tab pin handler. Reverse-geocodes to get a street name for
  // the Recollect lookup, then calls /api/sweep-check with coords —
  // sweep result + side_detection come back in one round trip.
  // AbortController on each call so fast drags resolve in pin order.
  const handleManualPinMove = useCallback(async (lat, lng) => {
    manualInflightRef.current?.abort();
    const ctrl = new AbortController();
    manualInflightRef.current = ctrl;
    setManualLoading(true);
    try {
      const geo = await post('reverse-geocode', { lat, lng }, ctrl.signal);
      const addr = addrFromGeo(geo) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      if (!ctrl.signal.aborted) setManualPos({ lat, lng, street: geo.street || 'Unknown' });
      const data = await post('sweep-check', {
        address: addr, today_date: clientToday(), past_noon: new Date().getHours() >= 12, lat, lng,
      }, ctrl.signal);
      if (!ctrl.signal.aborted) setManualSweepData(data);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      // Always settle, even on abort, so the loading hint clears.
      setManualLoading(false);
    }
  }, []);

  // Re-probe whenever Manual tab is shown without successful data —
  // covers fresh page loads, returns from app tab after an abort,
  // and any other path that left manualSweepData null.
  useEffect(() => {
    if (tab === 'manual' && !manualSweepData && !manualLoading) {
      handleManualPinMove(manualPos.lat, manualPos.lng);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

    // Strip just the OAuth params (code/state); preserve ?tab=.
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
      post('slack/oauth/callback', { code, state })
        .then(data => {
          if (!data.slack_user_id) throw new Error('Slack returned no user_id');
          setSlackUserId(data.slack_user_id);
          // Stash the HMAC session token paired with the slack id so
          // /enable + /disable can prove the requester owns it.
          // 30-min TTL — the user has to re-sign-in if they sit on
          // the page longer than that before subscribing.
          if (data.session) sessionStorage.setItem('slack_session', data.session);
          setNotifError('');
          showToast(`\u{1F510} Signed in as ${data.name || data.slack_user_id} — click Enable Daily Notifications to subscribe.`);
        })
        .catch(e => {
          setNotifError('Slack sign-in failed: ' + e.message);
          showToast('❌ Slack sign-in failed: ' + e.message);
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

    post('oauth/app/callback', { code, state })
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
          const isOnline = vlist[0].state === 'online';
          if (!isOnline) setWaking(true);
          setOauthStatus(isOnline
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

  return (
    <div className="container">
      <h1>{'\uD83D\uDE97'} Tesla Sweeper</h1>
      <p className="subtitle">Check if your car needs to move for Somerville street sweeping</p>

      <div className="tabs" role="tablist">
        {TABS.map(t => (
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

      {tab === 'app' && (
        <div role="tabpanel">
          {tokens ? (
            <>
              <div className="oauth-status">{transientToast || oauthStatus || '\u2705 Connected'}</div>
              {vehicles?.length === 0 && (
                <p style={{fontSize: '0.85rem', color: '#8b949e', marginBottom: 16}}>No vehicles registered on this Tesla account. Add a vehicle in the Tesla app and try again.</p>
              )}
              {vehicles?.length > 1 && (
                <div style={{marginBottom: 16}}>
                  <label>Select Vehicle</label>
                  <select value={selectedVehicle || ''} onChange={e => setSelectedVehicle(e.target.value)} style={{width: '100%', padding: '10px 12px', background: '#161b22', border: '1px solid #30363d', borderRadius: 6, color: '#c9d1d9', fontSize: '0.9rem'}}>
                    <option value="" disabled>Choose a vehicle...</option>
                    {vehicles.map(v => <option key={v.id} value={v.id}>{v.name}{v.is_stub ? ' (test)' : ''} ({v.state})</option>)}
                  </select>
                </div>
              )}
              {vehicles?.length > 0 && (
                <button onClick={() => handleCheckCar(selectedVehicle)} disabled={loading || (vehicles.length > 1 && !selectedVehicle)}>{loading ? (waking ? 'Waking your car... (up to 60s)' : 'Checking...') : 'Check My Car'}</button>
              )}
              <LocationResultsView pos={mapPos} data={sweepData} vehicleInfo={vehicleInfo} popupLabel="Your Car" />
              {vehicles?.length > 0 && (
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
              {(transientToast || oauthStatus) && <div className="oauth-status">{transientToast || oauthStatus}</div>}
            </>
          )}
        </div>
      )}

      {tab === 'manual' && (
        <div role="tabpanel">
          <p className="subtitle">
            Drag the pin to test any Somerville address. Same sweep + side-detection results as the Tesla flow, just driven by you instead of your car.
            {manualLoading && <span style={{ marginLeft: 6, fontStyle: 'italic' }}>(checking…)</span>}
          </p>
          {manualSweepData && !manualSweepData.found && (
            <div className="card" style={{ marginBottom: 12, fontSize: '0.85rem', color: '#8b949e' }}>
              {manualSweepData.message || 'No sweeping data for this location.'}
            </div>
          )}
          <LocationResultsView
            pos={manualPos}
            data={manualSweepData}
            draggable
            onPinMove={debouncedPinMove}
            popupLabel="Pin location"
          />
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          <p className="error">{error}</p>
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">&times;</button>
        </div>
      )}

      <footer>
        Somerville sweeping: Apr 1 – Dec 31 &middot; Data from Recollect/City of Somerville &middot; Always check street signs
        <br /><a href="https://github.com/VoX/tesla-sweeper">GitHub</a>
      </footer>
    </div>
  );
}

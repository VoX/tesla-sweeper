import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { readCachedCheck, saveCachedCheck, clearCachedCheck } from './lib/cache.js';
import { post, get } from './lib/api.js';
import { clientToday, pastNoon } from './lib/date.js';
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
  // Transient status during the OAuth flow ("Redirecting…", "Exchanging
  // code…", "Connected — N vehicles found"). The server now owns token
  // lifetime, so there's no "token expires in Xh" steady-state ticker.
  const [oauthStatus, setOauthStatus] = useState('');
  // Transient toast layered over oauthStatus for action feedback
  // ("slack pings enabled", "signed out"). Auto-clears after 5s.
  const [transientToast, setTransientToast] = useState('');
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    clearTimeout(toastTimerRef.current);
    setTransientToast(msg);
    toastTimerRef.current = setTimeout(() => setTransientToast(''), 5000);
  }, []);
  // BFF session state: the server holds the Tesla refresh_token; the
  // browser only carries a signed HttpOnly `session` cookie (invisible
  // to JS). `loggedIn` is resolved by GET /api/session/me on mount, or
  // set true after POST /api/session/create completes an OAuth return.
  // `authChecked` gates the first render so we don't flash the "Connect"
  // screen at a returning, already-signed-in user before /me answers.
  const [loggedIn, setLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Manual tab state — drag-to-set location, sweep + side detection
  // re-fetched on each pin move. Default centered on Somerville.
  const [manualPos, setManualPos] = useState({ lat: 42.385081, lng: -71.107841, street: 'Drag the pin to test' });
  const [manualSweepData, setManualSweepData] = useState(null);
  const [manualLoading, setManualLoading] = useState(false);
  const manualInflightRef = useRef(null);

  // Abort any in-flight manual probe on tab switch so its result
  // doesn't land into a tab you've left, and cancel a pending pin-drag
  // debounce so it doesn't fire 300ms after the user has navigated
  // away. The tabs use disjoint state (app: sweepData/mapPos/
  // vehicleInfo, manual: manualSweepData/manualPos) so cross-tab
  // cached results are fine to preserve — returning to a tab you
  // already loaded just shows the prior view instead of forcing a
  // re-check.
  useEffect(() => {
    manualInflightRef.current?.abort();
    clearTimeout(pinDebounceRef.current);
  }, [tab]);

  // One-shot unmount cleanup — drops pending debounce + toast timers
  // so they don't fire setState on a torn-down component (e.g. user
  // navigates away mid-debounce or right after a toast triggers).
  useEffect(() => () => {
    clearTimeout(toastTimerRef.current);
    clearTimeout(pinDebounceRef.current);
  }, []);

  // The slack id baked into a live HMAC session (token shape is
  // `${slackUserId}.${exp}.${mac}`) is authoritative — prefer it over
  // localStorage, which can hold a stale value somebody typed into the
  // manual "paste your slack id" box on a prior visit.
  const SLACK_ID_RE = /^U[A-Z0-9]+$/;
  const [slackUserId, setSlackUserId] = useState(() => {
    const fromSession = (sessionStorage.getItem('slack_session') || '').split('.')[0];
    if (SLACK_ID_RE.test(fromSession)) return fromSession;
    const fromLs = localStorage.getItem('tesla_slack_user_id') || '';
    return SLACK_ID_RE.test(fromLs) ? fromLs : '';
  });
  const [subscriptions, setSubscriptions] = useState(null);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState('');

  const autoCheckedRef = useRef(false);

  // Geo response → "{house_number} {street}" with empty parts dropped.
  // Both the Tesla and manual flows hit /reverse-geocode and need the
  // same formatted address for /sweep-check.
  const addrFromGeo = (geo) => [geo.house_number, geo.street].filter(Boolean).join(' ');
  // Slack session token (HMAC paired with slack_user_id) used to prove
  // ownership on /enable + /disable; empty string when not signed in.
  const slackSession = () => sessionStorage.getItem('slack_session') || '';

  useEffect(() => {
    if (selectedVehicle) localStorage.setItem('tesla_selected_vehicle', selectedVehicle);
    else localStorage.removeItem('tesla_selected_vehicle');
  }, [selectedVehicle]);

  useEffect(() => {
    // Only persist a real-looking slack id — otherwise a half-typed or
    // garbage value in the manual box becomes the sticky default on the
    // next page load.
    if (SLACK_ID_RE.test(slackUserId)) localStorage.setItem('tesla_slack_user_id', slackUserId);
  }, [slackUserId]);

  useEffect(() => {
    if (loggedIn && slackUserId) fetchSubscriptions(slackUserId);
  }, [loggedIn, slackUserId]);

  // Any 401 from a tesla-touching call means the BFF session is gone or
  // the refresh_token was revoked — there's nothing the SPA can do but
  // send the user back through Tesla OAuth. Drop to the Connect screen.
  const handleAuthExpired = useCallback(() => {
    setLoggedIn(false);
    setVehicles(null);
    setSelectedVehicle(null);
    setSubscriptions(null);
    autoCheckedRef.current = false;
    clearCachedCheck();
    reset();
    setOauthStatus('⚠️ Session expired — sign in with Tesla again.');
  }, []);

  const logout = async () => {
    try { await post('session/destroy', {}); } catch { /* best-effort; cookie clears regardless */ }
    setLoggedIn(false);
    setVehicles(null);
    setSelectedVehicle(null);
    setSubscriptions(null);
    autoCheckedRef.current = false;
    clearCachedCheck();
    reset();
    setOauthStatus('');
    // Sub-state survives logout under the shared-record model — say so.
    showToast('Signed out. Your noon notifications are still active — use the Notifications panel to turn them off.');
  };

  const fetchSubscriptions = async (uid) => {
    if (!uid) return;
    const data = await get(`notifications/status?slack_user_id=${encodeURIComponent(uid)}`)
      .catch(() => ({ subscriptions: [] }));
    setSubscriptions(data.subscriptions || []);
  };

  // Surface failures both inline (red text in the panel) AND as a toast —
  // the inline error sits below the Enable button, which is often below
  // the fold, so on its own it's easy to miss.
  const notifFail = (msg) => { setNotifError(msg); showToast('❌ ' + msg); };

  const enableNotifications = async () => {
    setNotifError('');
    if (!SLACK_ID_RE.test(slackUserId)) {
      notifFail('Sign in with Slack first — I need a verified Slack identity to send the DMs to.');
      return;
    }
    const vid = selectedVehicle || vehicles?.[0]?.id;
    if (!vid) { notifFail('Need a connected vehicle first'); return; }
    // The /enable confused-deputy gate needs a *live* Slack-OIDC HMAC
    // (per-tab, ~30-min TTL) — having a saved slack_user_id in
    // localStorage is not the same thing. Catch the empty case here so
    // the failure is obvious instead of an opaque 403 below the fold.
    if (!slackSession()) {
      notifFail('Your Slack session expired (or you haven’t signed in this visit). Click "Sign in with Slack" / "Switch slack account" above, then Enable.');
      return;
    }
    setNotifLoading(true);
    try {
      const veh = vehicles.find(v => v.id === vid);
      // No refresh_token in the body — the server pulls it from the
      // cookie-bound record. slack_session is the confused-deputy gate.
      const data = await post('notifications/enable', {
        vehicle_id: vid,
        vehicle_name: veh?.name || 'Unknown',
        slack_user_id: slackUserId,
        slack_session: slackSession(),
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
      notifFail(e.message);
    } finally {
      setNotifLoading(false);
    }
  };

  const disableNotifications = async (subId) => {
    // Disabling is also HMAC-gated — needs a live Slack session, same as
    // enabling. (Recovery path: re-do "Sign in with Slack", then Disable.
    // No Tesla session/cookie required for this.)
    if (!slackSession()) {
      notifFail('Your Slack session expired — click "Sign in with Slack" above, then Disable.');
      return;
    }
    setNotifLoading(true);
    setNotifError('');
    try {
      await post('notifications/disable', { id: subId, slack_user_id: slackUserId, slack_session: slackSession() });
      await fetchSubscriptions(slackUserId);
    } catch (e) {
      notifFail(e.message);
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

  // POST /api/vehicles — body is empty; the server resolves a Tesla
  // access_token from the session cookie. A 401 means the session/auth
  // is gone → kick back to OAuth.
  const fetchVehicles = async () => {
    let data;
    try {
      data = await post('vehicles', {});
    } catch (e) {
      if (e.status === 401) { handleAuthExpired(); return []; }
      throw e;
    }
    setVehicles(data.vehicles);
    if (data.vehicles.length === 1) setSelectedVehicle(data.vehicles[0].id);
    // Drop a stale selectedVehicle if the new list doesn't contain it —
    // happens after switching Tesla accounts.
    else if (selectedVehicle && !data.vehicles.some(v => v.id === selectedVehicle)) {
      setSelectedVehicle(null);
    }
    return data.vehicles;
  };

  const checkVehicle = async (vehicleId) => {
    let vehicle;
    const body = {};
    if (vehicleId) body.vehicle_id = vehicleId;
    try {
      vehicle = await post('check', body);
    } catch (e) {
      if (e.status === 401) { handleAuthExpired(); return; }
      throw e;
    }

    if (vehicle.no_vehicles) {
      setVehicles([]);
      setOauthStatus('✅ Connected — no vehicles on this account');
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

    const data = await post('sweep-check', { address: addr, today_date: clientToday(), past_noon: pastNoon(), lat: vehicle.latitude, lng: vehicle.longitude });
    if (data.found) {
      setSweepData(data);
      saveCachedCheck(vehicleId, { mapPos: mapPosVal, vehicleInfo: vehicleInfoVal, sweepData: data });
    } else {
      setError(`"${addr}" not in Somerville sweeping database.`);
    }
  };

  // Gentle post-login auto-check (returning user / page reload): hydrate
  // from the 6h cache if present, else only check if the car is already
  // online — never silently wake it on a passive page load. The "Check
  // My Car" button still force-wakes.
  const autoCheckOnLoad = useCallback((vlist) => {
    if (autoCheckedRef.current) return;
    const vid = selectedVehicle || (vlist.length === 1 ? vlist[0].id : null);
    if (!vid) return;
    autoCheckedRef.current = true;
    const cached = readCachedCheck(vid);
    if (cached) {
      setMapPos(cached.mapPos);
      setVehicleInfo(cached.vehicleInfo);
      setSweepData(cached.sweepData);
      return;
    }
    const v = vlist.find(x => x.id === vid);
    if (v?.state === 'online') checkVehicle(vid).catch(() => {});
  }, [selectedVehicle]);

  // Mount: GET /api/session/me. If authenticated, adopt the session,
  // pull the slack_user_id (if the server has one on the record), fetch
  // the vehicle list, and run the gentle auto-check. Skipped when we're
  // returning from an OAuth redirect (handled by the ?code= effect).
  const checkSession = useCallback(async () => {
    try {
      const me = await get('session/me').catch(() => ({ authenticated: false }));
      if (me.authenticated) {
        setLoggedIn(true);
        if (me.slack_user_id) setSlackUserId(me.slack_user_id);
        // fetchVehicles handles a 401 itself (→ handleAuthExpired). A
        // non-401 (5xx / network) shouldn't strand the SPA on the
        // "checking…" gate — surface it and let the user retry/reload.
        const vlist = await fetchVehicles().catch(e => { setError(e?.message || 'Could not load your vehicles'); return []; });
        autoCheckOnLoad(vlist);
      }
    } finally {
      setAuthChecked(true);
    }
  }, [autoCheckOnLoad]);

  // 300ms trailing debounce so a flurry of drag-releases (drag, drop,
  // re-drag) collapses into one server round-trip. AbortController
  // already cancels in-flight requests; this just stops us from
  // queueing them in the first place.
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
        address: addr, today_date: clientToday(), past_noon: pastNoon(), lat, lng,
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
    if (!loggedIn) return;
    if (loading) return;
    reset();
    setLoading(true);
    // 7s after start, assume the car was asleep and the server is in
    // its wake-and-poll loop. Switch the UI to "Waking..." so the user
    // knows the next ~30-50s of latency is expected, not a hang.
    const wakeHint = setTimeout(() => setWaking(true), 7000);
    try { await checkVehicle(vid || selectedVehicle); }
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

  // Mount: dispatch on whether we're returning from an OAuth redirect.
  // With ?code= → finish the Slack or Tesla exchange. Without → ask the
  // server if we already have a session (GET /api/session/me).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) { checkSession(); return; }

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
          // 30-min TTL — re-sign-in if you sit on the page longer.
          if (data.session) sessionStorage.setItem('slack_session', data.session);
          setNotifError('');
          showToast(`\u{1F510} Signed in as ${data.name || data.slack_user_id} — click Enable Daily Notifications to subscribe.`);
        })
        .catch(e => {
          setNotifError('Slack sign-in failed: ' + e.message);
          showToast('❌ Slack sign-in failed: ' + e.message);
        })
        .finally(() => { setNotifLoading(false); setAuthChecked(true); });
      // The Slack callback doesn't establish a Tesla session — still ask.
      checkSession();
      return;
    }

    if (!teslaState || state !== teslaState) {
      setError(`OAuth state mismatch (slack=${!!slackState}, tesla=${!!teslaState}). Try again.`);
      setAuthChecked(true);
      return;
    }

    setOauthStatus('Exchanging code for token...');
    setLoading(true);

    // POST /api/session/create: server exchanges the code, owns the
    // refresh_token, sets the session cookie, hands back the vehicles.
    post('session/create', { code, state })
      .then(async (data) => {
        setLoggedIn(true);
        const vlist = data.vehicles || [];
        setVehicles(vlist);
        if (vlist.length === 1) setSelectedVehicle(vlist[0].id);
        else if (selectedVehicle && !vlist.some(v => v.id === selectedVehicle)) setSelectedVehicle(null);
        if (vlist.length === 0) {
          setOauthStatus('✅ Connected — no vehicles on this account');
        } else if (vlist.length === 1) {
          // Just-completed OAuth: the user opted in via the login UX, so
          // it's reasonable to wake the car here even if asleep. The
          // gentle auto-check (returning visits) stays gated on
          // state==online so passive loads don't drain the battery.
          const isOnline = vlist[0].state === 'online';
          if (!isOnline) setWaking(true);
          setOauthStatus(isOnline
            ? '✅ Connected! Checking your car...'
            : '✅ Connected — waking your car (up to 60s)...');
          autoCheckedRef.current = true; // this counts as the auto-check
          try { await checkVehicle(vlist[0].id); }
          finally { setWaking(false); }
        } else {
          setOauthStatus(`✅ Connected — ${vlist.length} vehicles found. Select one to check.`);
        }
        // If this OAuth matched a previously-subscribed account record,
        // adopt its slack_user_id so the Notifications panel shows the
        // existing sub. (Triggers the subscriptions fetch via effect.)
        get('session/me').then(me => { if (me.authenticated && me.slack_user_id) setSlackUserId(me.slack_user_id); }).catch(() => {});
      })
      .catch(e => {
        if (e.status === 400) setOauthStatus('❌ Sign-in setup expired — please connect again.');
        else setOauthStatus('❌ ' + e.message);
      })
      .finally(() => {
        sessionStorage.removeItem('tesla_oauth_state');
        setLoading(false);
        setAuthChecked(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="container">
      <h1>{'🚗'} Tesla Sweeper</h1>
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
          {!authChecked ? (
            <p className="oauth-status">Checking your session…</p>
          ) : loggedIn ? (
            <>
              <div className="oauth-status">{transientToast || oauthStatus || '✅ Connected'}</div>
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
                  hasSlackSession={!!slackSession()}
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

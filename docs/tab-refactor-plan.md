# Tesla Sweeper — Tab Refactor + Shared Results View

## Goal

Two tabs only — **Tesla Login** and **Manual** — both rendering the **same**
results view (map with overlays, sweep result, side-detection diagnostic). The
only difference is how `{lat, lng}` is sourced:

- **Tesla Login** — pulled from Tesla Fleet API (existing `checkVehicle` flow).
  Map marker is **non-draggable**.
- **Manual** — pinned by the user dragging on the map. Marker is **draggable**;
  on `dragend` we re-fetch sweep + side-detection.

The current **Address** tab and **Test Side** tab are removed. Their
functionality is absorbed:

- The Test Side panel's diagnostic info + green/red overlays move into the
  shared results view (visible on both Tesla Login and Manual).
- The Address tab's free-text street search is dropped — Manual replaces it.
  Manual is faster for users (drag a pin) and exercises the same OSM-based
  side detection that we already trust.

---

## Current state (for reference)

### Components (`src/App.jsx`)
- `MapView({lat, lng, street})` — renders a Leaflet map, single non-draggable marker, "Your Car" popup. Shown on Address + App tabs.
- `SweepResults({data, vehicleName, fullAddr, lat, lng})` — StatusBox + Upcoming Events card + Details card. Shown on Address + App tabs.
- `TestSidePanel()` — self-contained panel: map, draggable marker, calls `/api/which-side`, renders 8-row diagnostic card. Shown only on Test Side tab.

### Endpoints
- `POST /api/sweep-check` — accepts `{address, today_date, past_noon, lat, lng}`. Returns `{found, place_name, place_id, status, title, message, sweep_events, car_side, side_source, house_num, days_until_next, latitude, longitude}`. **Internally calls `whichSide(lat, lng)` when coords are present** — but only surfaces `car_side` + `side_source`, not the full diagnostic.
- `POST /api/which-side` — accepts `{lat, lng}`. Returns the full diagnostic: `{side, road_name, perpendicular_offset_m, cross_sign, car_house_number, opposite_house_number, buildings_seen, side_parity, even_side, way_id, segment}`.
- `POST /api/check` — Tesla vehicle data lookup (location, battery).
- `POST /api/reverse-geocode` — Nominatim wrapper for `{lat, lng} → {street, house_number, city, state, display_name}`.

### Tab routing
URL `?tab=` accepts `address|app|test`. State synced via existing `useEffect([tab])`.

---

## Target design

### Server change — surface the full side-detection in sweep-check

`runSweepCheck` already calls `whichSide(lat, lng)` internally when coords are
supplied. Right now it discards everything except `side` and uses it to set
`car_side` / `side_source`. Change: stash the **full** `whichSide` result
object on the response under a new key:

```js
return {
  // ...existing fields...
  car_side: carSide,
  side_source: sideSource,
  side_detection: ws || null,   // NEW — full whichSide result, or null when no coords / lookup failed
  // ...
};
```

This eliminates the second client round trip to `/api/which-side`. The shared
results view reads `data.side_detection.segment` for the map overlays and the
parity / road / way-id fields for the diagnostic card.

`/api/which-side` stays as a standalone endpoint (zero new cost — it's already
the helper `runSweepCheck` calls). It's still useful for ad-hoc curl probes
during dev.

### Frontend — three shared sub-components, two tab containers

```
LocationResultsView (NEW shared component)
├── MapView (refactored — see below)
│     marker draggable=true|false from prop
│     renders green segment + red dashed perpendicular line from
│     data.side_detection.segment when present
│     calls onPinMove(lat,lng) on dragend when draggable
├── SweepResults (existing — minor cleanup)
│     StatusBox / Upcoming Events / Details card
│     "Your Side" row pulls from data.car_side + data.side_source as today
└── SideDetectionCard (NEW — extracted from TestSidePanel)
      Renders the 8 diagnostic rows when data.side_detection is non-null:
      side / reason-if-unknown / road / offset / cross sign /
      car-side house # / opposite-side house # / OSM way id

TeslaLoginTab
├── header: "✅ Connected" status, vehicle picker if 2+ cars,
│   "Check My Car" button, "Disconnect" button, NotificationsPanel
└── LocationResultsView
      pos = mapPos (from checkVehicle)
      draggable = false
      data = sweepData
      vehicleInfo = vehicleInfo
      loading = loading

ManualTab
├── header: short "Drag the pin to test any address" hint
└── LocationResultsView
      pos = manualPos (initialized to a Somerville default)
      draggable = true
      data = manualSweepData
      vehicleInfo = null
      loading = manualLoading
      onPinMove = handleManualPinMove
```

`LocationResultsView` is **the** point of code reuse. Both tabs render it
identically; the prop differences (`draggable`, `vehicleInfo`, `onPinMove`)
control behavior.

### MapView refactor (combines current MapView + TestSidePanel map)

```jsx
function MapView({ lat, lng, street, segment, draggable, onPinMove })
```

Behavior:
- `lat==null` → render nothing.
- First effect (mount-once): `loadLeaflet().then(setL)`.
- Map-init effect (`[L]`): create `L.map`, tile layer, marker (draggable per
  prop). When `draggable && onPinMove`, attach `dragend` → call `onPinMove`.
- Update effect (`[L, lat, lng, street]`): pan to new location, move marker,
  bind popup with `street` (or "Your Car" / "Pin location" depending on prop).
- Overlay effect (`[L, segment]`): draw green polyline for `segment.A→B` and
  red dashed for `segment.foot→{lat,lng}` whenever segment changes. Remove old
  overlays first. (Same logic TestSidePanel uses today.)

This single `MapView` component replaces both the current `MapView` and the
inlined map in `TestSidePanel`.

### SideDetectionCard (NEW)

```jsx
function SideDetectionCard({ detection }) {
  if (!detection) return null;
  return (
    <div className="card">
      <h3>Side detection</h3>
      <Row label="Side" value={<strong>...</strong>} />
      {detection.side === 'unknown' && detection.error && <Row label="Reason" value={detection.error} />}
      <Row label="Road" value={detection.road_name} />
      <Row label="Offset from centerline" value={`${detection.perpendicular_offset_m} m`} />
      <Row label="Cross sign" value={String(detection.cross_sign)} />
      <Row label="Car-side house #" value={detection.car_house_number ?? '—'} />
      <Row label="Opposite-side house #" value={detection.opposite_house_number ?? '—'} />
      <Row label="OSM way id" value={detection.way_id ?? '—'} />
    </div>
  );
}
```

Identical to the current TestSidePanel diagnostic, lifted out as its own
component. Renders nothing when `detection` is null (e.g. server couldn't
resolve coords for an address-only check — but Manual + Tesla flows always
have coords, so it'll always render in practice).

### Tabs / routing changes

- `tabs` array: `[{id:'app',...}, {id:'manual',...}]`. `'address'` and `'test'`
  removed.
- Tab-init state: whitelist becomes `['app','manual']`. URL with stale
  `?tab=address` or `?tab=test` falls through to `'app'`.
- `?address=` URL param handling deleted (was the auto-lookup hook).
- `?tab=` persistence effect drops `?tab=app` (still default) and writes
  `?tab=manual` otherwise.
- Tab-switch data-clear effect: clears `mapPos`, `sweepData`, `vehicleInfo`,
  `manualPos`, `manualSweepData` to keep each tab independent.

### State shape after refactor

App-level state that stays:
- `tokens`, `vehicles`, `selectedVehicle`, `subscriptions`, `slackUserId`,
  `oauthStatus`, `loading`, `waking`, `error`, `notifLoading`, `notifError`
- `mapPos`, `sweepData`, `vehicleInfo` — Tesla Login flow's results

App-level state that's NEW:
- `manualPos = useState({lat: 42.385, lng: -71.108})` — Somerville default,
  same as today's TestSidePanel default
- `manualSweepData = useState(null)` — sweep-check result for the manual flow
- `manualLoading = useState(false)`

App-level state removed:
- `address`, `autoLookupDone` — Address tab is gone

### Manual flow handler

```js
const handleManualPinMove = useCallback(async (lat, lng) => {
  setManualPos({ lat, lng });
  if (manualInflightRef.current) manualInflightRef.current.abort();
  const ctrl = new AbortController();
  manualInflightRef.current = ctrl;
  setManualLoading(true);
  try {
    const geo = await post('reverse-geocode', { lat, lng }, ctrl.signal);
    const addr = [geo.house_number, geo.street].filter(Boolean).join(' ') || `${lat}, ${lng}`;
    const data = await post('sweep-check', {
      address: addr,
      today_date: clientToday(),
      past_noon: new Date().getHours() >= 12,
      lat, lng,
    }, ctrl.signal);
    if (!ctrl.signal.aborted) setManualSweepData(data);
  } catch (e) {
    if (e.name !== 'AbortError') setError(e.message);
  } finally {
    if (!ctrl.signal.aborted) setManualLoading(false);
  }
}, []);
```

The Manual tab's initial mount calls `handleManualPinMove(default.lat, default.lng)` so the
view populates without requiring a drag.

The AbortController pattern matches the existing TestSidePanel — fast drags
cancel the prior probe so the latest pin position wins.

### Tesla Login flow (mostly unchanged)

`checkVehicle` already populates `mapPos`, `sweepData`, `vehicleInfo`. The
sweep-check call there already passes `lat`/`lng`, so once the server change
is in, `sweepData.side_detection` will be populated automatically — no client
work needed for the diagnostic to start showing on this tab.

---

## File-by-file changes

### `server.js`
1. `runSweepCheck`: capture the full `whichSide` result (currently discarded after extracting `side`). Return `side_detection: ws || null` on the response.
2. No other server changes — `/api/which-side` stays, `/api/sweep-check` API surface only **gains** a field.

### `src/App.jsx`
1. **Delete** `TestSidePanel` (≈90 lines).
2. **Refactor** `MapView` to the signature above (`segment`, `draggable`, `onPinMove`).
3. **Add** `SideDetectionCard` — ≈18 lines, lifted from TestSidePanel's diagnostic JSX.
4. **Add** `LocationResultsView` — orchestrates MapView + SweepResults + SideDetectionCard. ≈25 lines.
5. **Refactor** the `tab === 'app'` JSX block: header section unchanged, content section replaced by `<LocationResultsView pos={mapPos} draggable={false} data={sweepData} vehicleInfo={vehicleInfo} />`.
6. **Add** the `tab === 'manual'` JSX block: hint text + `<LocationResultsView pos={manualPos} draggable={true} onPinMove={handleManualPinMove} data={manualSweepData} vehicleInfo={null} />`.
7. **Delete** the `tab === 'address'` and `tab === 'test'` JSX blocks plus the `address` state, `autoLookupDone` ref, `handleCheckAddress`, the auto-lookup `useEffect`, and the `?address=` URL writes.
8. **Update** `tabs` array — remove `address` + `test`, add `manual`.
9. **Update** tab-init whitelist `['app','manual']`.
10. **Update** tab-switch data-clear to also reset `manualSweepData`.
11. **Update** the bottom `<MapView/><SweepResults/>` block — delete it entirely; the views now live inside `LocationResultsView` per-tab.

### `src/App.css`
- No new rules required — `LocationResultsView` reuses existing `.card`, `.row`, `.map-container`, `.status-box` classes.
- Optional: drop the `event-other` / debug-row inline styles if any are now unused (audit after ship).

---

## Code reuse audit

| Surface | Tesla Login | Manual |
|---|---|---|
| MapView | shared (draggable=false) | shared (draggable=true, onPinMove set) |
| Map overlays (green segment, red dashed) | shared | shared |
| SweepResults (StatusBox / events / details) | shared | shared |
| SideDetectionCard | shared | shared |
| LocationResultsView orchestrator | shared | shared |
| Sweep-check fetch (`POST /api/sweep-check`) | shared | shared |
| `vehicleInfo` row in SweepResults | populated | passed as null → row not rendered |

Differences:
- **Tesla Login only**: vehicle picker, "Check My Car" button, OAuth status,
  notifications panel, Disconnect button — all in the tab header above
  LocationResultsView.
- **Manual only**: a one-line "Drag the pin to test any address" hint above
  LocationResultsView.
- **How `{lat, lng}` enters state**: `checkVehicle` (Tesla API → `mapPos`) vs
  `handleManualPinMove` (drag → `manualPos`).

Everything else — the entire results-rendering surface — is one component
tree.

---

## URL behavior after refactor

- `https://claw.bitvox.me/sweeper/` → app tab (Tesla Login)
- `https://claw.bitvox.me/sweeper/?tab=manual` → Manual tab
- Stale `?tab=address` or `?tab=test` → falls back to app tab silently
- `?address=` param: ignored / dropped (was used by the deleted Address tab's auto-lookup)

---

## Risk notes

- **OAuth callback `setTab('app')`** — already correct; no change needed since
  `app` is the default and the only OAuth-bearing tab.
- **Manual tab on first mount** — fires one OSM probe immediately to populate
  the diagnostic. This is intentional (matches today's TestSidePanel behavior).
- **Server change is purely additive** — adds `side_detection` to the
  response. No client that's currently working will break.
- **Bundle size** — net negative: `TestSidePanel` (~90 lines) removed,
  `LocationResultsView` + `SideDetectionCard` add maybe 50 lines of replaced
  code. Roughly the same wire size; possibly slightly smaller after gzip/brotli.
- **Lazy-load leaflet** — unchanged. `loadLeaflet()` continues to gate map
  init in the new shared `MapView`.
- **Tab data isolation** — already wired (`useEffect([tab])` clears
  `sweepData`/`mapPos`/`vehicleInfo`); the new `manualSweepData`/`manualPos`
  follow the same pattern so cross-tab bleed is not reintroduced.

---

## Implementation order

1. Server change first (additive, deploy independently — no client breakage).
2. Add `SideDetectionCard` + refactor `MapView` to accept `segment` / `draggable` / `onPinMove` (no behavior change yet).
3. Add `LocationResultsView` and swap the app-tab content over to it.
4. Add Manual tab + `handleManualPinMove` + state.
5. Delete Address tab + Test Side tab + their state + `handleCheckAddress`.
6. Update `tabs` array, tab-init whitelist, tab-switch clear logic.
7. Verify build, restart service, smoke test:
   - Tesla Login tab still works end-to-end
   - Manual tab: drag pin → result + diagnostic populate
   - Tab switch clears prior state on each side
   - Refresh with `?tab=manual` lands on Manual

---

## Out of scope

- Search-by-address autocomplete (the deleted Address tab functionality is
  not coming back — Manual replaces it via drag-the-pin).
- Saving manually-set positions across reloads (could add later; today's flow
  re-defaults to the Somerville center on each load).
- Switching tabs while a Manual probe is in-flight gracefully — the existing
  AbortController + the tab-switch clear will handle it; nothing extra needed.

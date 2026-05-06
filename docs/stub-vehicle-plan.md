# Stub Test Vehicle — Implementation Plan

## Goal

Let VoX (or anyone testing the app without a Tesla on their account)
exercise the entire flow — connect → vehicles list → check car →
enable notifications → see daily DM — without owning a vehicle.

The stub is a server-side fiction injected when the real Tesla API
returns zero vehicles. It always reports the same GPS coordinates
(kit's parking spot in Somerville: `42.385081, -71.107841`), is
always "online", and has a stable id/name/vin so subscriptions can
target it.

## Constraints

- **Opt-in via env var.** Default off in prod. The stub is a debug
  affordance, not a feature; never accidentally subscribe a real user
  to a fake vehicle.
- **Single-tenant deploy.** No per-user state — the env flag is
  effectively the deployment's stub-mode preference.
- **Server-side only.** SPA stays unaware of "stub vs real" beyond a
  small visual badge; all branching lives in `server.js`.
- **Realistic data shape.** Stub responses match Tesla's documented
  vehicle / vehicle_data shapes so the existing client code paths
  don't need parallel branches.
- **Cron-safe.** Stub subs survive the daily noon-ET cron run and DM
  the user just like a real one would.

## Configuration

Add to `.bot.env` / `.env`:

```
STUB_VEHICLE_ENABLED=1
# optional overrides; defaults are kit's car spot in Somerville
STUB_VEHICLE_LAT=42.385081
STUB_VEHICLE_LNG=-71.107841
STUB_VEHICLE_NAME=Test Vehicle
```

Server-side constants (one place):

```js
const STUB_VEHICLE_ENABLED = process.env.STUB_VEHICLE_ENABLED === '1';
const STUB_VEHICLE_ID = 999999999999999;         // 15 digits, fits in safe int
const STUB_VEHICLE_VIN = 'STUBTEST00000000000';  // 19 chars, won't collide
const STUB_VEHICLE_LAT = parseFloat(process.env.STUB_VEHICLE_LAT) || 42.385081;
const STUB_VEHICLE_LNG = parseFloat(process.env.STUB_VEHICLE_LNG) || -71.107841;
const STUB_VEHICLE_NAME = process.env.STUB_VEHICLE_NAME || 'Test Vehicle';
const STUB_REFRESH_TOKEN = 'STUB_REFRESH_TOKEN';  // sentinel; cron recognizes it
```

`STUB_VEHICLE_ID` is a fixed number so client-side `=== STUB_VEHICLE_ID`
checks work cleanly. `STUB_REFRESH_TOKEN` is the magic value persisted
to `subscriptions.json` for stub subs — the cron path branches on it.

## Wire-in points

### 1. `/api/vehicles` — append stub when Tesla returns 0

```js
// server.js — inside /api/vehicles handler, after parsing tesla response:
let vehicles = (await vehiclesRes.json()).response || [];
if (STUB_VEHICLE_ENABLED && vehicles.length === 0) {
  vehicles = [{ id: STUB_VEHICLE_ID, display_name: STUB_VEHICLE_NAME, vin: STUB_VEHICLE_VIN, state: 'online' }];
}
```

The SPA's vehicle picker shows it like any other car. Selecting it
proceeds through the same flow.

### 2. `/api/check` — return canned drive_state for the stub

```js
// server.js — inside /api/check, before fetchVehicleData:
if (STUB_VEHICLE_ENABLED && String(vid) === String(STUB_VEHICLE_ID)) {
  return res.json({
    vehicle_name: STUB_VEHICLE_NAME,
    latitude: STUB_VEHICLE_LAT,
    longitude: STUB_VEHICLE_LNG,
    battery_level: 78,
  });
}
```

No Tesla wake, no rate-limit cost, no auth needed for the stub fetch.

### 3. `/api/notifications/enable` — bypass vehicle-id Tesla lookup for stub

The current handler validates the `refresh_token` by hitting Tesla's
token endpoint, then confirms `vehicle_id` is on that account. For
the stub, both checks are noise.

```js
// server.js — inside /api/notifications/enable, after the session gate:
if (STUB_VEHICLE_ENABLED && String(vehicle_id) === String(STUB_VEHICLE_ID)) {
  // Skip the refresh-token round-trip and the /api/1/vehicles lookup.
  // The cron will branch on STUB_REFRESH_TOKEN to short-circuit.
  // ... fall through to subs.filter / push, but write STUB_REFRESH_TOKEN
  //     instead of the user-supplied one.
} else {
  // existing real-Tesla validation flow
}
```

The persisted sub looks like:

```json
{
  "id": "...",
  "slack_user_id": "U060NLFUM",
  "vehicle_id": 999999999999999,
  "vehicle_name": "Test Vehicle",
  "refresh_token": "STUB_REFRESH_TOKEN",
  "created_at": "...",
  "last_check_at": null
}
```

### 4. Cron path — short-circuit when `sub.refresh_token === STUB_REFRESH_TOKEN`

Inside `runNotifications`, before `teslaTokenExchange`:

```js
let latitude, longitude, battery;
if (STUB_VEHICLE_ENABLED && sub.refresh_token === STUB_REFRESH_TOKEN) {
  latitude = STUB_VEHICLE_LAT;
  longitude = STUB_VEHICLE_LNG;
  battery = 78;
  // skip teslaTokenExchange + fetchVehicleData
} else {
  // existing Tesla-API flow:
  //   teslaTokenExchange → patchSub on rotation → fetchVehicleData
}
out.battery_level = battery ?? null;

// Then continue with the normal flow:
//   reverseGeocodeLocation(latitude, longitude)
//   runSweepCheck({ address, lat, lng })
//   shouldNotifySweep + postSlackDM
```

The reverse-geocode and Recollect lookups are real for the stub —
the whole point is to exercise that pipeline. Slack DMs go out for
real to the user's real Slack. Confused-deputy gate still applies on
`/enable` (you have to be signed in with Slack to subscribe a stub).

### 5. SPA — small visual badge (optional, polish)

Detect `vehicle.id === STUB_VEHICLE_ID` in the vehicle picker and the
results card; add `(test)` next to the name. Lets the operator
distinguish at a glance:

```jsx
{v.name}{v.id === 999999999999999 && ' (test)'} ({v.state})
```

Trivial; can ship in a follow-up.

## Files touched

| File | Change |
|---|---|
| `.bot.env` (local, not committed) | new env vars |
| `server.js` | stub constants + 4 branch points (~25 lines net) |
| `src/App.jsx` | optional `(test)` badge |
| `docs/stub-vehicle-plan.md` | this doc |

## Implementation order

1. **Constants + `/api/vehicles` injection.** Smallest blast radius.
   Verify SPA picker shows the stub when Tesla returns 0.
2. **`/api/check` canned response.** Verify SPA "Check My Car" works
   end-to-end against the stub.
3. **`/api/notifications/enable` bypass.** Verify subscriptions.json
   gets a stub sub with `STUB_REFRESH_TOKEN`.
4. **Cron short-circuit.** Manually trigger `/api/notifications/run`
   with the bearer token and verify the stub sub flows through to a
   real Slack DM. Test T-1, T-2, T-3 by setting `STUB_VEHICLE_LAT`/
   `LNG` to a Somerville address with sweep events on those days, or
   by using `today_date` overrides on the manual probe path.
5. **SPA badge.** Cosmetic, ship anytime.

Each step is independently reverifiable. If any breaks, revert just
that commit; the rest stay live.

## Test plan

- **No-Tesla account** (VoX's case): connect Tesla → vehicles list
  shows only "Test Vehicle" → Check My Car → see Somerville result
  with side detection → enable notifications → wait for noon-ET cron
  (or hit `/api/notifications/run` manually) → receive Slack DM.
- **Has-Tesla account** (kit's case): connect Tesla → vehicles list
  shows the real car only (stub suppressed because Tesla returned
  ≥1) → existing flow unchanged.
- **Stub disabled** (`STUB_VEHICLE_ENABLED=0` or unset): no-Tesla
  user sees the existing "no vehicles registered" hint. Stub branches
  in `/check`, `/enable`, and cron all skip.

## Risk / out-of-scope

- **Stub subs persist across deploys** — if `STUB_VEHICLE_ENABLED` is
  later set to 0, the cron will hit the real Tesla path with
  `STUB_REFRESH_TOKEN` and fail. Add a deploy-time cleanup script or
  document the manual remove from `subscriptions.json`.
- **No mock for Tesla wake / sleep states.** Stub is always online;
  not testing the wake-and-poll loop.
- **No mock for OAuth callback.** User still has to complete a real
  Tesla OAuth flow to get a (real, but unused) `tokens` object in
  the SPA. The stub injects only at `/vehicles` and downstream.
- **No mock for Recollect/Nominatim/Overpass.** Those calls go to
  the real upstreams using real Somerville data. That's the point —
  we're testing the integration.
- **Stub vehicle_id collision** — picked `999999999999999` (15
  digits). Real Tesla IDs are 16 digits. Collision: zero.

## Net diff estimate

- `server.js`: +~30 lines (constants + 4 branch points)
- `src/App.jsx`: +1 line (badge)
- `.bot.env`: +3 lines (new env vars; not committed)
- 1 commit per implementation step (5 commits total).

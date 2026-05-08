# Tesla Sweeper

Street sweeping checker for Somerville, MA. Tells you if your car needs to move.

## Architecture

The repo is an npm workspace with two packages:

- **`src/server/`** (`@tesla-sweeper/server`) — express bound to `127.0.0.1` (default port 20040, configurable via `PORT`). Decomposed into `config.js` (env loader, MUST import first), `app.js` (express bootstrap + route mounting), `index.js` (listen + cron + recovery), plus subdirs:
  - `crypto/{session,bearer}.js` — HMAC session token + bearer auth
  - `store/subscriptions.js` — atomic file-backed sub store
  - `integrations/{tesla,slack,nominatim,overpass,recollect}.js` — external API helpers, each self-contained with its own `fetchWithTimeout`
  - `sweep/check.js` — `runSweepCheck` composer
  - `notifications/{planner,cron}.js` — classifier + the noon-ET / Sun-8PM crons
  - `routes/{vehicles,oauth,notifications,probes}.js` — express Routers
  - `middleware/{errors,brotli}.js` — `wrap` async-error helper + brotli `.br` serving
  - `__tests__/` — vitest unit tests for every module
- **`src/client/`** (`@tesla-sweeper/client`) — Preact + Vite SPA. Two tabs: **Tesla Login** (OAuth) and **Manual** (drag-the-pin). Both use the same `LocationResultsView` (map + sweep card + side-detection diagnostic). Layout:
  - `App.jsx` — orchestrator: state + tab routing + OAuth callback handling + action handlers
  - `components/{StatusBox,Row,MapView,SideDetectionCard,SweepResults,LocationResultsView,NotificationsPanel}.jsx`
  - `lib/{cache,api,date,slack-input}.js` — pure helpers
  - `leaflet-loader.js` — lazy-load via cached promise
  - `__tests__/` — vitest + happy-dom + @testing-library/preact
- **Compression:** Brotli `.br` siblings are pre-built by a `closeBundle` Vite plugin (`src/client/vite.config.js`) writing to repo-root `dist/`, served by `middleware/brotli.js` before `express.static`. Whatever reverse proxy fronts the app should pass `Accept-Encoding: br` through; gzip falls through to the proxy.
- **Storage:** `data/subscriptions.json` (mode 0600, dir 0700, atomic temp+rename writes) — daily-notification subs with Tesla `refresh_token`, `consecutive_failures`, `last_dm_date`, `last_digest_date`, `last_dm_error_at`. Gitignored.
- **Notifications:** in-process `node-cron`. Daily `0 12 * * *` America/New_York fires `runNotifications({mode:'daily'})`; weekly `0 20 * * 0` America/New_York fires the Sunday digest (`mode:'weekly'`). Missed-run + missed-digest recovery helpers run on boot if `last_run_at` / `last_digest_run_at` is stale.

## External APIs

### Recollect (sweeping data)
- `address-suggest` → fuzzy-matches Somerville addresses → `place_id`
- `events` → sweeping events for a place over a date range
- Service ID `349` (Somerville). No auth.
- Flag names encode schedule: `Sweeping_8AM_12PM_EVEN`, etc.

### Nominatim (geocoding)
- **Rate limit: 1 req/sec.** In-process queue in `nominatimFetch`. Don't remove it.
- Used only by `reverseGeocodeLocation` (cron + Manual tab).

### OSM Overpass (side detection)
- `whichSide(lat, lng)` queries named drivable highways within 50m, picks the closest segment, computes a 2D cross-product, then queries OSM buildings tagged `addr:street=<wayName>` within 80m to derive even/odd parity per side.
- Way names are escape-sanitized before going into the Overpass string literal (`\`, `"`, control chars).
- Two sequential Overpass calls per probe; no in-process rate limit (Overpass tolerates ~2 req/s/IP).

### Tesla Fleet API
- Base: `fleet-api.prd.na.vn.cloud.tesla.com`
- Token endpoint: `fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` (NOT `auth.tesla.com`)
- Auth URL: `auth.tesla.com/oauth2/v3/authorize`
- Token exchange: `application/x-www-form-urlencoded`, NOT JSON
- Required `audience` on code exchange: the Fleet API base URL
- Asleep vehicle returns 408; `teslaWakeAndPoll` issues `wake_up` and polls 12× 5s.

## OAuth Flows

### Tesla Login
- Server-side credentials in `.env`: `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI`.
- Endpoints: `/api/oauth/app/start`, `/callback`, `/refresh`. Client never sees the secret.

### Sign in with Slack (OIDC)
- Endpoints: `/api/slack/oauth/{start,callback}`. Scope `openid profile`.
- Callback decodes the `id_token` JWT (no second `userInfo` round-trip) for `https://slack.com/user_id`, `team_id`, email, name. No signature verification — token came from Slack over TLS in the same exchange.
- **The callback also issues an HMAC session token** (`signSession`) bound to the slack_user_id, 30-min TTL. Required on `/api/notifications/{enable,disable}` to close the confused-deputy hole — without it anyone with a Tesla refresh_token could subscribe arbitrary slack_user_ids.

### Token storage
- `tokens` in localStorage: `{access_token, refresh_token, expires_at}`. No `client_id`/`oauth_mode` (single OAuth path).
- Single-flight refresh via `refreshPromise` ref. 60s expiry-check interval.
- Tesla rotates refresh tokens on each exchange; persisted server-side per-iteration via `patchSub`.

## Daily notifications subsystem

### Endpoints
- `POST /api/notifications/enable` — body `{refresh_token, vehicle_id, vehicle_name, slack_user_id, session}`. Verifies the HMAC session before doing anything; validates the refresh_token via one Tesla round-trip; confirms vehicle_id is on that account (string-coerced compare since Tesla IDs are >`MAX_SAFE_INTEGER`); persists; sends a confirmation Slack DM. Stub bypass: when `isStubVehicle(vehicle_id)`, the Tesla validation is skipped and `STUB_REFRESH_TOKEN` is persisted instead.
- `POST /api/notifications/disable` — body `{id, slack_user_id, session}`. Session gate + slack_user_id match required.
- `GET /api/notifications/status?slack_user_id=X` — returns subs filtered by user (with `publicSub` field-strip dropping `refresh_token`/`last_result`/etc).
- `POST /api/notifications/run` — bearer-auth via `NOTIFICATIONS_RUN_TOKEN` (`crypto.timingSafeEqual`). Iterates subs, fires the cron flow.

### Cron flow per-sub
1. Skip Tesla calls entirely when `sub.refresh_token === STUB_REFRESH_TOKEN` (stub mode); otherwise `teslaTokenExchange` + persist rotated token via `patchSub`.
2. `fetchVehicleData` → drive_state lat/lng. Stub mode uses `STUB_VEHICLE_LAT/LNG` and a canned battery=78.
3. `reverseGeocodeLocation` → address.
4. `runSweepCheck({address, lat, lng})` — calls `whichSide()` internally for OSM-based side detection; falls back to `houseNum % 2` if OSM has no data.
5. `patchSub({last_check_at, last_result, consecutive_failures})` — failure count resets to 0 on success, increments on error.
6. After the per-sub loop: dispatch a Slack DM via `postSlackDM` for any sub that should notify, gated on `last_dm_date !== todayET` (prevents re-DM after restart).
7. Stuck-sub loop: subs with `consecutive_failures >= 3` get a one-time "your sub broke" DM, with a 24h cooldown via `last_dm_error_at`.

### Confirmation + cron DMs
- All use `postSlackDM(slack_user_id, text)` calling `chat.postMessage` with `SLACK_BOT_TOKEN`. Channel param can be a U-id; Slack auto-resolves to a 1:1 IM.
- Currently the bot identity is shared with the host (tinyclaw). Splitting to a dedicated app would silo the DMs from the bot's chat-loop context.

## Stub test vehicle (`STUB_VEHICLE_ENABLED=1`)

Lets devs/testers exercise the full flow without owning a Tesla. See `docs/stub-vehicle-plan.md` for the design rationale.

- `/api/vehicles` injects `{id: 999999999999999, name: "Test Vehicle", state: "online"}` when Tesla returns 0 vehicles.
- `/api/check`, `/api/notifications/enable`, and the cron path all branch on `isStubVehicle(vehicle_id)` / `sub.refresh_token === STUB_REFRESH_TOKEN` to short-circuit Tesla calls. Reverse-geocode + Recollect + Slack DM still run for real.
- Default coords: `42.385081, -71.107841` (Somerville). Override via `STUB_VEHICLE_LAT`/`LNG`.
- Off in normal prod. Set `STUB_VEHICLE_ENABLED=0` and remove any stub subs from `subscriptions.json` before disabling, otherwise the cron will try Tesla with `STUB_REFRESH_TOKEN` and fail.

## Frontend specifics

- **Lazy leaflet**: `src/client/leaflet-loader.js` returns a cached promise that imports leaflet + marker assets + leaflet.css on first call. Both `MapView` and the Manual-tab probe path gate map init on `await loadLeaflet()`. The leaflet chunk is ~150 KB raw / 38 KB brotli; only fetched when a map renders. Initial JS bundle is ~35 KB raw / 12 KB brotli.
- **Inline CSS**: a `transformIndexHtml` Vite plugin (`inlineMainCss`) embeds the bundled main CSS as a `<style>` tag in `index.html`. Eliminates the FOUC frame Firefox flagged when `<link rel="stylesheet">` was loaded async after the module script.
- **Brotli pre-compression**: a `closeBundle` Vite plugin walks `dist/` and writes `.br` siblings for `.js`/`.css`/`.html`/`.svg` files ≥1KB at quality 11. The plugin runs after vite finalizes preload helpers — earlier `generateBundle`-based version compressed un-resolved `__VITE_PRELOAD__` tokens and broke the bundle.
- **Tab routing**: `?tab=manual` persists; `?tab=app` is the default and gets stripped from the URL. Legacy `?tab=address|test|address=foo` falls through to the default.
- **Cache versioning**: `tesla_last_check` localStorage entry has a `v: 1` field; mismatched versions return null on read.

## Side detection diagnostic

`runSweepCheck` returns `side_detection` (the full `whichSide()` result) on every response when coords are supplied. The SPA's `SideDetectionCard` renders the diagnostic rows (side, road, offset, cross sign, car-side house #, opposite house #, OSM way id) below `SweepResults`. `MapView` reads `side_detection.segment` to draw the green road segment + red dashed perpendicular line. Same display on Tesla Login and Manual tabs.

## Key Design Decisions

### Timezone handling
The client sends `today_date` as `YYYY-MM-DD` (via `new Date().toLocaleDateString('sv-SE')`) and `past_noon` as a boolean. Server-side `todayET` for DM-dedup uses `Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York'})`.

### Sweep status after noon
If sweeping was scheduled today but `past_noon` is true, status is demoted to `info` ("Sweeping Done for Today").

### Multi-vehicle support
`/api/vehicles` lists all vehicles on the account. Multiple → dropdown. One → auto-selects. Zero + `STUB_VEHICLE_ENABLED` → stub injected.

### Partner registration
The app must be registered with the Tesla Fleet API. Tesla pulls the public key from `<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem` — keep `keys/public-key.pem` reachable at that path via your reverse proxy. Private key in `keys/` (gitignored).

## Development

```bash
npm install
npm run dev    # Express (20040) + Vite dev server (5173) with proxy
npm run build  # Production build to dist/ (includes brotli .br siblings + inlined CSS)
npm start      # Express serves dist/ in production
```

Vite proxies `/sweeper/api/*` to `localhost:20040` in dev mode. The React-style code uses `preact/hooks` — make sure new text inputs use `onInput` not `onChange` (preact's onChange fires on blur, not per keystroke).

## Common Pitfalls

- **Relative API paths:** Frontend fetch calls use `api/...` not `/api/...`. Caddy strips `/sweeper/`, so absolute paths 404 from the public URL.
- **Token endpoint domain:** Use `fleet-auth.prd.vn.cloud.tesla.com` for token exchange, NOT `auth.tesla.com`.
- **Content-Type for tokens:** Tesla requires `application/x-www-form-urlencoded`, not JSON.
- **Leaflet popup XSS:** Use `textContent`/`createTextNode` for popup content; never template strings with `bindPopup`. Street names come from Nominatim and are untrusted.
- **Leaflet marker icons:** Imported from leaflet's dist images via `src/client/leaflet-loader.js` to override `L.Icon.Default` options. Vite's marker-icon URL handling needs this or the default icons 404.
- **Preact onChange:** Native DOM `change` semantic — fires on blur for text inputs. Use `onInput` for controlled inputs.
- **Tesla vehicle IDs > MAX_SAFE_INTEGER:** Always `String()`-coerce when comparing in JS. `/api/notifications/enable` does this for the account check + the dedup filter; tests should round-trip via JSON to catch precision bugs.
- **`SESSION_HMAC_KEY` missing:** All `/enable` + `/disable` requests 403. Boot logs `[boot] SESSION_HMAC_KEY unset…`. Generate with `openssl rand -hex 32` and put in `.env`.
- **Stub-mode persistent subs:** If a sub was created with `STUB_VEHICLE_ENABLED=1` and the flag is later turned off, the cron will try to refresh `STUB_REFRESH_TOKEN` against Tesla and fail forever. Manually remove the sub from `subscriptions.json` before disabling stub mode.

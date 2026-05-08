# Tesla Sweeper

Check if your car needs to move for Somerville, MA street sweeping.

## What it does

Looks up the street sweeping schedule for any Somerville address using the city's [Recollect](https://api.recollect.net/) data. Tells you if sweeping is happening today, tomorrow, or when the next event is — and which side of the street it covers, with OSM-based detection of which side of the street you're actually parked on.

Two ways to check:
- **Tesla Login** — sign in with your Tesla account; the app pulls the car's GPS, geocodes it, runs the sweep check, and shows a map + side-detection diagnostic.
- **Manual** — drag a pin on the map. Same results view as the Tesla flow, just driven by you instead of your car. Useful for testing addresses you're considering parking at, or for users who don't have a Tesla on the account.

### OSM-based side detection

Older versions guessed your side from house-number parity (`houseNum % 2`). That breaks when a car is parked across from its own address (oversized lots, no opposing house, etc.). The current detection:

1. Queries OSM Overpass for the closest named drivable highway segment to your pin
2. Computes a 2D cross-product to decide which side of the road segment your pin is on
3. Queries OSM buildings tagged with that street name and tallies even-vs-odd house numbers per side
4. Maps your cross-product side to even/odd via the building parity vote

Falls back to the parity heuristic if OSM has no building data for the street. The diagnostic card on the results view shows exactly which segment + buildings the algorithm saw, so you can sanity-check it.

### Daily Slack notifications

Once connected, opt-in via "🔔 Daily Slack Pings" to receive a Slack DM 1, 2, and 3 days before each sweeping event that affects your side. Sign in with Slack (OIDC) auto-fills your user id; subscriptions store the Tesla `refresh_token` server-side (mode 0600) so a noon-ET cron can refresh, locate, and notify without the user keeping the page open.

A confirmation DM is sent the moment you click Enable so you know the wiring works. If a sub starts failing (Tesla token revoked, vehicle removed), you get a one-time "your sub broke, re-enable" DM after 3 consecutive failures, then once per day until you re-enable.

### 6h check cache

Subsequent page opens within 6 hours of a successful "Check My Car" hydrate from `localStorage` instead of waking the car. The button still bypasses cache for an explicit live check.

## Stack

- **Backend:** Node.js / Express, proxies Tesla Fleet API + Recollect + Nominatim + OSM Overpass
- **Frontend:** Preact + Vite, Leaflet for maps (lazy-loaded)
- **Assets:** Vite-built bundle plus brotli-precompressed `.br` siblings served by an Express middleware (falls through to gzip via whatever fronts it)

## Repo layout

The repo is an npm workspace coordinating two packages:

```
src/server/  — @tesla-sweeper/server (express backend)
src/client/  — @tesla-sweeper/client (preact + vite SPA)
```

Common commands run from the repo root and fan out to the workspaces.

## Running locally

```bash
cp .env.example .env  # Add your Tesla app + Slack OIDC credentials
npm install           # installs both workspaces
npm run dev           # runs server (20040) + vite (5173) concurrently
```

Open `http://localhost:5173/sweeper/`.

For production:

```bash
npm run build  # builds the client bundle into dist/
npm start      # runs the server, which serves dist/
npm test       # runs vitest in both workspaces
```

### Environment variables

| Variable | Required for | Description |
|---|---|---|
| `TESLA_CLIENT_ID` | Tesla Login | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla Login | Tesla developer app client secret |
| `TESLA_REDIRECT_URI` | Tesla Login | OAuth redirect URI registered with the Tesla developer app (must match exactly) |
| `SLACK_CLIENT_ID` | Sign in with Slack | OIDC client id from a Slack app (api.slack.com/apps) |
| `SLACK_CLIENT_SECRET` | Sign in with Slack | OIDC client secret |
| `SLACK_REDIRECT_URI` | Sign in with Slack | Same URL added under app's Redirect URLs |
| `SLACK_BOT_TOKEN` | Confirmation + cron DMs | `xoxb-…` bot token with `chat:write` scope |
| `SESSION_HMAC_KEY` | /enable + /disable gate | 32-byte hex (`openssl rand -hex 32`). Without it, those endpoints reject every request. |
| `NOTIFICATIONS_RUN_TOKEN` | Daily cron | Bearer token guarding `POST /api/notifications/run`. Generate with `openssl rand -hex 32`. |
| `STUB_VEHICLE_ENABLED` | Test mode | Set to `1` to inject a stub "Test Vehicle" when Tesla returns 0 vehicles. Off in normal prod. |
| `STUB_VEHICLE_LAT` / `_LNG` / `_NAME` | Test mode | Optional overrides for the stub's location/name. Defaults to a Somerville address. |

## How sweeping detection works

1. Address is matched via Recollect's `address-suggest` endpoint for Somerville (service 349)
2. Sweeping events for the next 30 days are fetched from the matched place
3. Lat/lng (from Tesla GPS or Manual pin) is run through `whichSide()` for OSM-based side detection; falls back to `houseNum % 2` if OSM has no building data for the street
4. Status is determined: danger (move now), warning (tomorrow/other side), safe (no upcoming sweep)
5. After noon, today's sweep status is demoted to "done" since sweeping runs 8AM-12PM

Sweeping season runs April 1 – December 31. Outside that window, most addresses will show no scheduled events.

## Tesla integration

Uses the [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api) OAuth2 authorization_code flow:

1. User clicks "Connect Tesla Account"
2. Redirected to Tesla's auth page to grant vehicle data + location access
3. On callback, token is exchanged server-side (credentials never exposed to browser)
4. Vehicle list is fetched — user selects which car if multiple
5. Car's GPS is reverse-geocoded to a street address via Nominatim
6. Address is checked against Recollect's sweeping database; OSM is queried for side-detection geometry

Tokens are stored in localStorage for session persistence. Refresh tokens are used to maintain access without re-login. The app is registered with Tesla Fleet API and hosts a public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`.

## Security model

- **`SESSION_HMAC_KEY` gate**: `/api/notifications/enable` and `/disable` require an HMAC session token issued by `/api/slack/oauth/callback`. Without this binding, anyone with a Tesla refresh_token could subscribe an arbitrary `slack_user_id`. Without the env var set, both endpoints reject every request.
- **Bearer auth on `/api/notifications/run`**: `crypto.timingSafeEqual` comparison.
- **Body size limit**: Express bodies capped at 10kb.
- **No CORS headers**: server binds to `127.0.0.1` by default; expose via a same-origin reverse proxy.
- **Refresh tokens** live in `data/subscriptions.json` (mode 0600, dir 0700). Never logged. The `wrap()` async-error helper returns a generic 502 to the client without leaking error details.
- **Stub vehicle**: `STUB_VEHICLE_ENABLED=1` injects a test vehicle when Tesla returns 0; only intended for dev/testing. The cron path branches on a `STUB_REFRESH_TOKEN` sentinel to short-circuit Tesla calls for stub subs.

## License

MIT

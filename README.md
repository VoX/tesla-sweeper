# Tesla Sweeper

Check if your car needs to move for Somerville, MA street sweeping.

**Live:** [claw.bitvox.me/sweeper/](https://claw.bitvox.me/sweeper/)

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
- **Hosting:** Caddy reverse proxy on an EC2 instance with brotli pre-compressed assets

## Running locally

```bash
cp .env.example .env  # Add your Tesla app + Slack OIDC credentials
npm install
npm run dev
```

Starts both the Express backend (port 20040) and Vite dev server (port 5173) with API proxying. Open `http://localhost:5173/sweeper/`.

For production:

```bash
npm run build
npm start
```

### Environment variables

| Variable | Required for | Description |
|---|---|---|
| `TESLA_CLIENT_ID` | Tesla Login | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla Login | Tesla developer app client secret |
| `TESLA_REDIRECT_URI` | Tesla Login | OAuth redirect URI (e.g. `https://claw.bitvox.me/sweeper/`) |
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

## Operations

### Hosting
- **Box:** EC2 Graviton (4 vCPU / 16 GB) running Amazon Linux 2023, single-tenant.
- **Reverse proxy:** Caddy on `claw.bitvox.me` with `redir /sweeper /sweeper/ 308` + `handle_path /sweeper/*` doing `encode zstd gzip` and proxying to `localhost:20040`. Brotli `.br` files served by the Express middleware pass through Caddy's `encode` directive untouched.
- **TLS:** Caddy auto-issues from Let's Encrypt.

### Service
- **Unit:** `tesla-sweeper.service` (systemd user-level).
- **Process:** `node server.js` listens on `127.0.0.1:20040`. Restart with `systemctl --user restart tesla-sweeper.service`.
- **Logs:** `journalctl --user -u tesla-sweeper.service`. Notable lines: `[wake]`, `[check]`, `[vehicles]`, `[cron]`, `[fallback]`, Tesla token errors.

### State on disk
- **`.env`** (mode 0600) — all credentials. Never committed (gitignored).
- **`data/subscriptions.json`** (mode 0600, dir mode 0700) — daily-notification subscriptions including Tesla `refresh_token`s, `consecutive_failures`, `last_dm_date`, `last_dm_error_at`. Atomic writes via temp+rename. Gitignored.
- **`dist/`** — built Preact bundle + brotli `.br` siblings, served by Express's static middleware. Rebuilt with `npm run build`.

### Endpoints (probes / ops)

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness + `{ok, last_run_at, sub_count}` for monitoring |
| `POST /api/which-side` `{lat, lng}` | OSM side-detection probe (no auth) |
| `POST /api/sweep-check` `{address, lat, lng, today_date, past_noon}` | Direct sweep check (no auth, lat/lng required as finite numbers in valid range) |
| `POST /api/notifications/run` (Bearer auth) | Manually fire the daily cron |

### Notification cron
- **In-process via `node-cron`.** Registered from the `app.listen` callback so the scheduler comes up with the service.
- `runNotifications()` refreshes each sub's Tesla token (rotating in place via `patchSub`), wakes asleep cars, reverse-geocodes, runs `runSweepCheck`, sends a Slack DM via `chat.postMessage` for any sub with `days_until_next ∈ {1,2,3}` AND a side that matches the user's parked side. Per-sub failures are isolated.
- **DM dedup**: each successful DM patches `last_dm_date: <todayET>` so a restart between dispatch and `last_run_at` write doesn't re-DM.
- **Stuck-sub notice**: after 3 consecutive failures, DM the user once ("your sub broke"); 24h cooldown before re-DMing.
- **Missed-run recovery:** on startup past noon ET with `last_run_at` from a prior date, fire one immediately.
- `POST /api/notifications/run` (bearer-auth via `NOTIFICATIONS_RUN_TOKEN`) calls the same function for manual triggering.

### Common ops

| Action | Command |
|---|---|
| Tail logs | `journalctl --user -u tesla-sweeper -f` |
| Restart after code change | `npm run build && systemctl --user restart tesla-sweeper.service` |
| List subscriptions | `cat data/subscriptions.json \| jq` |
| Trigger run on demand | `curl -X POST -H "Authorization: Bearer $NOTIFICATIONS_RUN_TOKEN" localhost:20040/api/notifications/run` |
| Liveness check | `curl localhost:20040/healthz` |
| Side-detection probe | `curl -X POST -d '{"lat":42.385081,"lng":-71.107841}' -H 'Content-Type: application/json' localhost:20040/api/which-side` |

### Failure modes
- **Tesla token revoked**: cron logs the error, increments `consecutive_failures`, DMs the user after 3 in a row. Other subs unaffected.
- **Vehicle won't wake**: 60s wake-and-poll ceiling. Sub stays valid; next day's run retries.
- **Slack `chat.postMessage` fails**: cron-side failures are surfaced in the cron log line and the per-sub `last_result.error`. `dm_sent: false` doesn't get persisted as `last_dm_date`, so next run retries.
- **Recollect/Nominatim/Overpass outage**: the failing call throws, sub's `last_result.error` records it, no DM sent. Auto-recovers next run.

## Security model

- **`SESSION_HMAC_KEY` gate**: `/api/notifications/enable` and `/disable` require an HMAC session token issued by `/api/slack/oauth/callback`. Without this binding, anyone with a Tesla refresh_token could subscribe an arbitrary `slack_user_id`. Without the env var set, both endpoints reject every request.
- **Bearer auth on `/api/notifications/run`**: `crypto.timingSafeEqual` comparison; the endpoint is internet-reachable through Caddy.
- **Body size limit**: Express bodies capped at 10kb.
- **No CORS headers**: server listens on `127.0.0.1:20040`, only reachable through Caddy at the same origin.
- **Refresh tokens** live in `data/subscriptions.json` (mode 0600, dir 0700). Never logged. The `wrap()` async-error helper returns a generic 502 to the client without leaking error details.
- **Stub vehicle**: `STUB_VEHICLE_ENABLED=1` injects a test vehicle when Tesla returns 0; only intended for dev/testing. The cron path branches on a `STUB_REFRESH_TOKEN` sentinel to short-circuit Tesla calls for stub subs.

## License

MIT

# Tesla Sweeper

Check if your car needs to move for Somerville, MA street sweeping.

**Live:** [claw.bitvox.me/sweeper/](https://claw.bitvox.me/sweeper/)

## What it does

Looks up the street sweeping schedule for a Somerville address using the city's [Recollect](https://api.recollect.net/) data. Tells you if sweeping is happening today, tomorrow, or when the next event is — and whether it's on your side of the street (even/odd).

Two ways to check:
- **Tesla Login** — sign in with your Tesla account to auto-locate your car and check the sweeping schedule
- **Address lookup** — type any Somerville address to see the schedule

Also supports a **Custom OAuth** tab for developers who want to use their own Tesla API credentials.

### Daily Slack notifications

Once connected, opt-in via "🔔 Daily Slack Pings" to receive a Slack DM from `tinyclaw` 1, 2, and 3 days before each sweeping event that affects your side. Sign in with Slack (OIDC) auto-fills your user id, or paste it manually. Subscriptions store the Tesla `refresh_token` server-side (mode 0600) so a noon-ET cron can refresh, locate, and notify without the user keeping the page open.

A confirmation DM is sent the moment you click Enable so you know the wiring works.

### 6h check cache

Subsequent page opens within 6 hours of a successful "Check My Car" hydrate from `localStorage` instead of waking the car again. The button still bypasses cache for an explicit live check.

## Stack

- **Backend:** Node.js / Express, proxies Tesla Fleet API + Recollect API + Nominatim geocoding
- **Frontend:** React 18 + Vite, Leaflet for maps
- **Hosting:** Caddy reverse proxy on an EC2 instance

## Running locally

```bash
cp .env.example .env  # Add your Tesla app credentials
npm install
npm run dev
```

This starts both the Express backend (port 20040) and Vite dev server (port 5173) with API proxying. Open `http://localhost:5173/sweeper/`.

For production:

```bash
npm run build
npm start
```

### Environment variables

| Variable | Required for | Description |
|---|---|---|
| `TESLA_CLIENT_ID` | Tesla Login tab | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla Login tab | Tesla developer app client secret |
| `TESLA_REDIRECT_URI` | Tesla Login tab | OAuth redirect URI (e.g. `https://claw.bitvox.me/sweeper/`) |
| `NOTIFICATIONS_RUN_TOKEN` | Daily cron | Bearer token guarding `POST /api/notifications/run`. Generate with `openssl rand -hex 32`. |
| `SLACK_CLIENT_ID` | Sign in with Slack | OIDC client id from a Slack app (api.slack.com/apps) |
| `SLACK_CLIENT_SECRET` | Sign in with Slack | OIDC client secret |
| `SLACK_REDIRECT_URI` | Sign in with Slack | Same URL added under app's Redirect URLs (e.g. `https://claw.bitvox.me/sweeper/`) |
| `SLACK_BOT_TOKEN` | Confirmation + cron DMs | `xoxb-…` bot token with `chat:write` scope |

## How sweeping detection works

1. Address is matched via Recollect's `address-suggest` endpoint for Somerville (service 349)
2. Sweeping events for the next 30 days are fetched from the matched place
3. House number parity (even/odd) is compared against each event's side designation
4. Status is determined: danger (move now), warning (tomorrow/other side), safe (no upcoming sweep)
5. After noon, today's sweep status is demoted to "done" since sweeping runs 8AM-12PM

Sweeping season runs April 1 – December 31. Outside that window, most addresses will show no scheduled events.

## Tesla integration

The app uses the [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api) OAuth2 authorization_code flow:

1. User clicks "Connect Tesla Account"
2. Redirected to Tesla's auth page to grant vehicle data + location access
3. On callback, token is exchanged server-side (credentials never exposed to browser)
4. Vehicle list is fetched — user selects which car if multiple
5. Car's GPS coordinates are reverse-geocoded to a street address via Nominatim
6. Address is checked against Recollect's sweeping database

Tokens are stored in localStorage for session persistence. Refresh tokens are used to maintain access without re-login. The app is registered with Tesla Fleet API and hosts a public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`.

### Tesla developer setup (for Custom OAuth)

1. Create an app at [developer.tesla.com/dashboard](https://developer.tesla.com/dashboard)
2. Enable scopes: **Vehicle Information** and **Vehicle Location**
3. Set redirect URI to your app's URL
4. Host an EC P-256 public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`
5. Register with the Fleet API via the partner_accounts endpoint

## Operations

### Hosting
- **Box:** EC2 Graviton (4 vCPU / 16 GB) running Amazon Linux 2023, single-tenant.
- **Reverse proxy:** Caddy on `claw.bitvox.me` with `handle_path /sweeper/*` stripping the prefix and proxying to `localhost:20040`. The `/sweeper/api/*` namespace IS internet-reachable — `/api/notifications/run` therefore relies on `NOTIFICATIONS_RUN_TOKEN` + `crypto.timingSafeEqual` for auth.
- **TLS:** Caddy auto-issues from Let's Encrypt.

### Service
- **Unit:** `tesla-sweeper.service` (systemd user-level, lives at `~/.config/systemd/user/tesla-sweeper.service`).
- **Process:** `node server.js` listens on `127.0.0.1:20040`. Restart with `systemctl --user restart tesla-sweeper.service`.
- **Logs:** `journalctl --user -u tesla-sweeper.service`. Notable lines: `[wake]`, `[check]`, `[vehicles]`, Tesla token errors.

### State on disk
- **`.env`** (mode 0600) — all credentials. Never committed (gitignored).
- **`data/subscriptions.json`** (mode 0600) — daily-notification subscriptions including Tesla `refresh_token`s. Atomic writes via temp+rename. Gitignored.
- **`dist/`** — built React bundle served by Express's static middleware. Rebuilt with `npm run build`.

### Notification cron
- **In-process via `node-cron`.** `server.js` registers `cron.schedule('0 12 * * *', runNotifications, { timezone: 'America/New_York' })` from the `app.listen` callback, so the scheduler comes up with the service and goes down with it.
- `runNotifications()` refreshes each sub's Tesla token (rotating in place), wakes asleep cars, reverse-geocodes, runs `runSweepCheck`, sends a Slack DM via `chat.postMessage` for any result with `days_until_next ∈ {1,2,3}` AND a side that matches the user's parked side. Per-sub failures are isolated.
- **Missed-run recovery:** on startup, if it's past noon ET and `subscriptions.json#last_run_at` is from a prior date, fire one immediately. Guards against the service being restarted between noon and midnight.
- `POST /api/notifications/run` (bearer-auth via `NOTIFICATIONS_RUN_TOKEN`) calls the same function for manual triggering / monitoring.

### Common ops

| Action | Command |
|---|---|
| Tail logs | `journalctl --user -u tesla-sweeper -f` |
| Restart after code change | `npm run build && systemctl --user restart tesla-sweeper.service` |
| List subscriptions | `cat data/subscriptions.json \| jq` |
| Disable a sub manually | `curl -X POST -H 'Content-Type: application/json' -d '{"id":"...","slack_user_id":"U..."}' localhost:20040/api/notifications/disable` |
| Trigger run on demand | `curl -X POST -H "Authorization: Bearer $NOTIFICATIONS_RUN_TOKEN" localhost:20040/api/notifications/run` |
| Rotate run token | edit `.env`, `systemctl --user restart`, update scheduler payload |

### Failure modes
- **Tesla 401 on cron**: refresh token expired (90+ days unused) or revoked. User must re-Enable. Other subs unaffected.
- **Vehicle won't wake (504 in run)**: car in deep hibernation or no cell signal. Sub stays valid; next day's run retries.
- **Slack `chat.postMessage` fails**: the test DM error is surfaced in the SPA banner; cron-side failures are logged but don't crash the run.
- **Recollect/Nominatim outage**: `runSweepCheck` throws, sub's `last_result.error` records it, no DM sent. Auto-recovers next run.

## License

MIT

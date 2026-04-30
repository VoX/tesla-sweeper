# Tesla Sweeper

Street sweeping checker for Somerville, MA. Tells you if your car needs to move.

## Architecture

- **Backend:** `server.js` — Express server on port 20040. Proxies three external APIs and serves the built React app as static files. Loads credentials from `.env`.
- **Frontend:** `src/App.jsx` — React 18 app with Vite. Three tabs: Address lookup, Tesla Login (pre-configured OAuth), Custom OAuth (BYO credentials).
- **Hosting:** Caddy reverse proxy at `claw.bitvox.me/sweeper/` with `handle_path /sweeper/*` stripping the prefix.
- **Storage:** `data/subscriptions.json` (mode 0600, atomic writes) — daily-notification subscriptions including Tesla `refresh_token`s. Gitignored.
- **Daily notifications:** in-process `node-cron` schedule registered from `app.listen`'s callback, fires `0 12 * * *` in `America/New_York`. `runNotifications()` refreshes tokens, wakes vehicles, reverse-geocodes, sweep-checks, and sends Slack DMs in-line for `days_until_next ∈ {1,2,3}` results that match the user's parked side. Missed-run recovery on startup if past noon ET and `last_run_at` is from a prior date.

## External APIs

### Recollect (sweeping data)
- `address-suggest` endpoint: fuzzy-matches Somerville addresses → returns `place_id`
- `events` endpoint: returns sweeping events for a place over a date range
- Service ID: `349` (Somerville)
- Flag names encode schedule: `Sweeping_8AM_12PM_EVEN`, `Sweeping_12AM_8AM_ODD`
- No auth required. User-Agent header recommended.

### Nominatim (geocoding)
- **Rate limit: 1 request/second.** There's an in-process queue in `server.js`. Don't remove it or Nominatim will IP-ban the server.
- Used for both reverse geocoding (Tesla GPS → address) and forward geocoding (address → map pin).

### Tesla Fleet API
- Fleet API base: `fleet-api.prd.na.vn.cloud.tesla.com`
- Token endpoint: `fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` (NOT `auth.tesla.com` for token exchange)
- Auth URL: `auth.tesla.com/oauth2/v3/authorize`
- Content-Type for token exchange: `application/x-www-form-urlencoded` (NOT JSON)
- Required `audience` parameter on code exchange: the Fleet API base URL
- `prompt_missing_scopes=true` on authorize URL to handle scope additions
- Vehicle may be asleep (408) — user must wake it via Tesla app first.

## OAuth Flows

### Tesla pre-configured ("Tesla Login" tab)
- Credentials stored server-side in `.env` (TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, TESLA_REDIRECT_URI)
- Client never sees the client_secret — server handles token exchange
- Endpoints: `/api/oauth/app/start`, `/api/oauth/app/callback`, `/api/oauth/app/refresh`

### Tesla custom ("Custom OAuth" tab)
- User provides their own client_id, client_secret, redirect_uri
- Optional partner registration checkbox (calls partner_accounts endpoint)
- Endpoints: `/api/oauth/start`, `/api/oauth/callback`, `/api/oauth/refresh`

### Sign in with Slack (OIDC)
- Used to identify the user for notification subscriptions without manual id-paste
- Endpoints: `/api/slack/oauth/{start,callback}`. Scope: `openid profile`.
- Callback decodes the `id_token` JWT (no second `userInfo` round-trip) for `https://slack.com/user_id`, `team_id`, email, name. No signature verification — token came from Slack over TLS in the same request.
- Frontend stores `slack_oauth_state` in sessionStorage; the OAuth-callback effect disambiguates slack vs tesla state on redirect.
- Manual paste still supported as a fallback (`parseSlackInput` extracts U-id from raw input or pasted slack URL).

### Token storage
- Access token, refresh token, client_id, oauth_mode, and expiry stored in localStorage
- client_secret is NOT stored in localStorage — only lives in sessionStorage during the redirect flow
- Refresh tokens are single-use (Tesla rotates them); the new one is saved on each refresh
- 60-second interval checks token expiry and auto-refreshes

## Daily notifications subsystem

### Endpoints
- `POST /api/notifications/enable` — body `{refresh_token, oauth_mode, client_id?, vehicle_id, vehicle_name, slack_user_id}`. Validates token via one Tesla refresh, persists, sends a confirmation Slack DM. Returns `{enabled, id, test_dm_ok, test_dm_error}`.
- `POST /api/notifications/disable` — body `{id, slack_user_id}`. Slack id must match — guards against one user disabling another's sub.
- `GET /api/notifications/status?slack_user_id=X` — returns subs filtered by user (with `publicSub` field-strip dropping `refresh_token`).
- `POST /api/notifications/run` — bearer-auth via `NOTIFICATIONS_RUN_TOKEN` (constant-time compare via `crypto.timingSafeEqual` because the endpoint is internet-reachable through Caddy). Iterates subs, refreshes tokens (persisted per-iteration on rotation), wakes vehicles, runs `runSweepCheck`, returns aggregated results. Failures are isolated per-sub.

### Confirmation + cron DMs
- Both use `postSlackDM(slack_user_id, text)` calling `chat.postMessage` with `SLACK_BOT_TOKEN` (currently reusing tinyclaw's bot identity). Channel param can be a U-id; Slack auto-resolves to a 1:1 IM.

### 6h check cache
- `localStorage` key `tesla_last_check` stores `{vehicle_id, at, mapPos, vehicleInfo, sweepData}`.
- Auto-check on page load hydrates from cache if fresh AND vehicle_id matches; otherwise only fires a live check if the car is `state==online` (asleep cars stay asleep on passive loads).
- "Check My Car" button always bypasses cache.

## Key Design Decisions

### Timezone handling
The client sends `today_date` as a `YYYY-MM-DD` string and `past_noon` as a boolean. Previous attempts to do server-side timezone math with `tz_offset` double-corrected when the server wasn't in UTC.

### Sweep status after noon
If sweeping was scheduled today but `past_noon` is true, status is demoted to `info` ("Sweeping Done for Today"). The `past_noon` flag comes from the client's local time.

### Even/odd side detection
House number parity from the address determines which side of the street the car is on. Events matching the car's side are highlighted red with a "YOUR SIDE" badge.

### Multi-vehicle support
`/api/vehicles` lists all vehicles on the account. If multiple, the UI shows a dropdown selector. If one, it auto-selects. If zero, shows a friendly message.

### Partner registration
The app is registered with Tesla Fleet API via `/api/1/partner_accounts`. A public key is hosted at `claw.bitvox.me/.well-known/appspecific/com.tesla.3p.public-key.pem` (served by Caddy). The private key lives in `keys/` (gitignored).

## Development

```bash
npm install
npm run dev    # Express (20040) + Vite dev server (5173) with proxy
npm run build  # Production build to dist/
npm start      # Express serves dist/ in production
```

Vite proxies `/sweeper/api/*` to `localhost:20040` in dev mode. The React app detects `import.meta.env.DEV` to choose the right API base path.

## Deployment

Runs as `tesla-sweeper.service` (systemd user unit):
```
ExecStart=/usr/bin/node server.js
Environment=PORT=20040
```

After code changes: `npm run build && systemctl --user restart tesla-sweeper.service`

## Common Pitfalls

- **Relative API paths:** Frontend fetch calls use `api/...` not `/api/...`. Caddy strips `/sweeper/` prefix, so absolute paths 404 from the public URL.
- **Token endpoint domain:** Use `fleet-auth.prd.vn.cloud.tesla.com` for token exchange, NOT `auth.tesla.com`. Different rate limits.
- **Content-Type for tokens:** Tesla requires `application/x-www-form-urlencoded`, not JSON. This was a bug that took a while to find.
- **Scope consent caching:** Tesla caches prior consent. If new scopes are added to the app, users must re-authorize. `prompt_missing_scopes=true` handles this.
- **Recollect address matching:** `10 harvard st` returns nothing (no such address), `10 harvard` matches `10 Harvard Pl` (different street). The suggest endpoint is fuzzy.
- **Leaflet popup XSS:** Use `textContent`/`createTextNode` for popup content, never template strings with `bindPopup`. Street names come from Nominatim and are untrusted.
- **Leaflet marker icons:** Must import marker-icon/shadow PNGs from leaflet dist and override `L.Icon.Default` options, otherwise Vite bundling breaks the default icon paths.

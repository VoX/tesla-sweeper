# Tesla Sweeper

Street sweeping checker for Somerville, MA. Tells you if your car needs to move.

## Architecture

- **Backend:** `server.js` — Express server on port 20040. Proxies three external APIs and serves the built React app as static files.
- **Frontend:** `src/App.jsx` — Single-component React 18 app with Vite. Three tabs: Address lookup, Tesla OAuth, Bearer Token.
- **Hosting:** Caddy reverse proxy at `claw.bitvox.me/sweeper/` with `handle_path /sweeper/*` stripping the prefix.

## External APIs

### Recollect (sweeping data)
- `address-suggest` endpoint: fuzzy-matches Somerville addresses → returns `place_id`
- `events` endpoint: returns sweeping events for a place over a date range
- Service ID: `349` (Somerville)
- Flag names encode schedule: `Sweeping_8AM_12PM_EVEN`, `Sweeping_12AM_8AM_ODD`
- No auth required. User-Agent header recommended.

### Nominatim (reverse geocoding)
- **Rate limit: 1 request/second.** There's an in-process queue in `server.js`. Don't remove it or Nominatim will IP-ban the server.
- Used to convert Tesla GPS coordinates → street address.

### Tesla Fleet API
- Base: `fleet-api.prd.na.vn.cloud.tesla.com`
- OAuth2 authorization_code flow. No personal access tokens exist.
- Vehicle may be asleep (408) — user must wake it via Tesla app first.
- The app intentionally has the user provide their own `client_id` and `client_secret`. This is a demo app design choice, not a bug.

## Key Design Decisions

### Timezone handling
The client sends `today_date` as a `YYYY-MM-DD` string, not a timezone offset. Previous attempts to do server-side timezone math with `tz_offset` double-corrected when the server wasn't in UTC. Client-side date string is the correct approach.

### Sweep status after noon
If sweeping was scheduled today but it's past 12PM, status is demoted to `info` ("Sweeping Done for Today") instead of `danger`. Sweeping runs 8AM-12PM.

### Even/odd side detection
House number parity from the address determines which side of the street the car is on. This is compared against `EVEN`/`ODD` in the Recollect flag names. If the sweep is on the opposite side, status is `warning` instead of `danger`.

### API 404 catch
`app.all('/api/*')` returns JSON 404 before the SPA catch-all `app.get('*')`. Without this, typo'd API paths silently return index.html.

### Fetch timeouts
All outbound fetch calls use `AbortSignal.timeout(12000)`. A hung upstream will not hold Express connections open indefinitely.

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
- **Python 3.9 syntax:** The old Python backend is deleted, but if you ever see `int | None` — that's 3.10+ syntax and this box runs 3.9.
- **Recollect address matching:** `10 harvard st` returns nothing (no such address), `10 harvard` matches `10 Harvard Pl` (different street). The suggest endpoint is fuzzy.
- **Leaflet popup XSS:** Use `textContent`/`createTextNode` for popup content, never template strings with `bindPopup`. Street names come from Nominatim and are untrusted.

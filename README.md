# Tesla Sweeper

Check if your car needs to move for Somerville, MA street sweeping.

**Live:** [claw.bitvox.me/sweeper/](https://claw.bitvox.me/sweeper/)

## What it does

Looks up the street sweeping schedule for a Somerville address using the city's [Recollect](https://api.recollect.net/) data. Tells you if sweeping is happening today, tomorrow, or when the next event is — and whether it's on your side of the street (even/odd).

Two ways to check:
- **Tesla Login** — sign in with your Tesla account to auto-locate your car and check the sweeping schedule
- **Address lookup** — type any Somerville address to see the schedule

Also supports a **Custom OAuth** tab for developers who want to use their own Tesla API credentials.

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

| Variable | Description |
|---|---|
| `TESLA_CLIENT_ID` | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla developer app client secret |
| `TESLA_REDIRECT_URI` | OAuth redirect URI (e.g. `https://claw.bitvox.me/sweeper/`) |

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

## License

MIT

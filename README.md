# Tesla Sweeper

Check if your car needs to move for Somerville, MA street sweeping.

**Live:** [claw.bitvox.me/sweeper/](https://claw.bitvox.me/sweeper/)

## What it does

Looks up the street sweeping schedule for a Somerville address using the city's [Recollect](https://api.recollect.net/) data. Tells you if sweeping is happening today, tomorrow, or when the next event is — and whether it's on your side of the street (even/odd).

Three ways to check:
- **Address lookup** — type an address, get the schedule
- **Tesla OAuth** — connect your Tesla account to auto-locate your car
- **Bearer token** — paste a Tesla API token directly

## Stack

- **Backend:** Node.js / Express, proxies Tesla Fleet API + Recollect API + Nominatim geocoding
- **Frontend:** React 18 + Vite, Leaflet for maps
- **Hosting:** Caddy reverse proxy on an EC2 instance

## Running locally

```bash
npm install
npm run dev
```

This starts both the Express backend (port 20040) and Vite dev server (port 5173) with API proxying. Open `http://localhost:5173/sweeper/`.

For production:

```bash
npm run build
npm start
```

## How sweeping detection works

1. Address is matched via Recollect's `address-suggest` endpoint for Somerville (service 349)
2. Sweeping events for the next 30 days are fetched from the matched place
3. House number parity (even/odd) is compared against each event's side designation
4. Status is determined: danger (move now), warning (tomorrow/other side), safe (no upcoming sweep)

Sweeping season runs April 1 – December 31. Outside that window, most addresses will show no scheduled events.

## Tesla integration

The Tesla OAuth and bearer token flows use the [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api) to get the vehicle's GPS coordinates, then reverse-geocode via Nominatim to get the street address. The client ID and secret are provided by the user (this is a demo app).

## License

MIT

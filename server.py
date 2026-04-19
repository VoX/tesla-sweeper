"""Tesla Sweeper — FastAPI backend for proxying Tesla API calls and Recollect sweeping data."""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from datetime import date, timedelta
import httpx

app = FastAPI()

TESLA_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com"
NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
RECOLLECT_BASE = "https://api.recollect.net/api"
RECOLLECT_SERVICE = 349
UA = "TeslaSweeper/1.0"


class CheckRequest(BaseModel):
    token: str


class GeocodeRequest(BaseModel):
    lat: float
    lng: float


class SweepRequest(BaseModel):
    address: str


@app.post("/api/check")
async def check_vehicle(req: CheckRequest):
    headers = {
        "Authorization": f"Bearer {req.token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(f"{TESLA_BASE}/api/1/vehicles", headers=headers)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach Tesla API: {e}")

        if resp.status_code == 401:
            raise HTTPException(status_code=401, detail="Invalid or expired Tesla token")
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Tesla API error: {resp.text}")

        data = resp.json()
        vehicles = data.get("response", [])
        if not vehicles:
            raise HTTPException(status_code=404, detail="No vehicles found on this account")

        vehicle = vehicles[0]
        vehicle_id = vehicle["id"]
        vehicle_name = vehicle.get("display_name", "Unknown")

        try:
            loc_resp = await client.get(
                f"{TESLA_BASE}/api/1/vehicles/{vehicle_id}/vehicle_data",
                params={"endpoints": "location_data"},
                headers=headers,
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to get vehicle data: {e}")

        if loc_resp.status_code != 200:
            raise HTTPException(status_code=loc_resp.status_code, detail=f"Tesla vehicle data error: {loc_resp.text}")

        loc_data = loc_resp.json()
        drive_state = loc_data.get("response", {}).get("drive_state", {})
        lat = drive_state.get("latitude")
        lng = drive_state.get("longitude")

        if lat is None or lng is None:
            raise HTTPException(status_code=404, detail="Could not determine vehicle location")

        return {"vehicle_name": vehicle_name, "latitude": lat, "longitude": lng}


@app.post("/api/reverse-geocode")
async def reverse_geocode(req: GeocodeRequest):
    params = {"format": "jsonv2", "lat": req.lat, "lon": req.lng, "zoom": 18, "addressdetails": 1}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(f"{NOMINATIM_BASE}/reverse", params=params, headers={"User-Agent": UA})
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Geocode request failed: {e}")

        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Nominatim returned an error")

        data = resp.json()
        address = data.get("address", {})
        return {
            "street": address.get("road", ""),
            "house_number": address.get("house_number", ""),
            "city": address.get("city") or address.get("town") or address.get("village") or "",
            "state": address.get("state", ""),
            "display_name": data.get("display_name", ""),
        }


@app.post("/api/sweep-check")
async def sweep_check(req: SweepRequest):
    """Look up sweeping schedule via Recollect API for a Somerville address."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Step 1: address suggest → place_id
        try:
            suggest_resp = await client.get(
                f"{RECOLLECT_BASE}/areas/Somerville/services/{RECOLLECT_SERVICE}/address-suggest",
                params={"q": req.address, "locale": "en-US"},
                headers={"User-Agent": UA},
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Recollect suggest failed: {e}")

        if suggest_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Recollect address suggest error")

        suggestions = suggest_resp.json()
        if not suggestions:
            return {"found": False, "message": "Address not found in Somerville sweeping database"}

        place = suggestions[0]
        place_id = place["place_id"]
        place_name = place.get("name", req.address)

        # Step 2: get events for next 30 days
        today = date.today()
        after = today.isoformat()
        before = (today + timedelta(days=30)).isoformat()

        try:
            events_resp = await client.get(
                f"{RECOLLECT_BASE}/places/{place_id}/services/{RECOLLECT_SERVICE}/events",
                params={"after": after, "before": before, "locale": "en-US"},
                headers={"User-Agent": UA},
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Recollect events failed: {e}")

        if events_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Recollect events error")

        events_data = events_resp.json()
        events = events_data.get("events", events_data) if isinstance(events_data, dict) else events_data
        sweep_events = []
        for event in events:
            day = event.get("day", "")
            flags = event.get("flags", [])
            for flag in flags:
                name = flag.get("name", "")
                if "Sweeping" in name or "sweeping" in name:
                    sweep_events.append({
                        "date": day,
                        "type": name,
                        "side": "even" if "EVEN" in name else "odd" if "ODD" in name else "both",
                        "time": "8:00 AM - 12:00 PM" if "8AM_12PM" in name else name,
                    })

        # Determine house number parity for side matching
        import re
        house_match = re.match(r'(\d+)', req.address.strip())
        house_num = int(house_match.group(1)) if house_match else None
        car_side = "even" if house_num and house_num % 2 == 0 else "odd" if house_num else None

        # Determine status
        today_str = today.isoformat()
        tomorrow_str = (today + timedelta(days=1)).isoformat()
        sweeping_today = [e for e in sweep_events if e["date"] == today_str]
        sweeping_tomorrow = [e for e in sweep_events if e["date"] == tomorrow_str]

        def matches_side(events, car_side):
            if not car_side:
                return True, True
            exact = any(e["side"] == car_side for e in events)
            opposite = any(e["side"] != car_side and e["side"] != "both" for e in events)
            return exact, opposite

        if sweeping_today:
            exact_match, opposite_only = matches_side(sweeping_today, car_side)
            sides = ", ".join(set(e["side"] + " side" for e in sweeping_today))
            if exact_match:
                status = "danger"
                title = "MOVE YOUR CAR"
                message = f"Sweeping TODAY on YOUR side ({sides}, 8AM-12PM). $50 fine!"
            elif opposite_only:
                status = "warning"
                title = "Sweeping Today — Other Side"
                message = f"Sweeping today but on the {sides} (you're on the {'even' if car_side == 'even' else 'odd'} side at #{house_num}). You're probably fine, but verify with posted signs."
            else:
                status = "danger"
                title = "MOVE YOUR CAR"
                message = f"Sweeping TODAY ({sides}, 8AM-12PM). $50 fine!"
        elif sweeping_tomorrow:
            exact_match, opposite_only = matches_side(sweeping_tomorrow, car_side)
            sides = ", ".join(set(e["side"] + " side" for e in sweeping_tomorrow))
            if exact_match:
                status = "warning"
                title = "Sweeping Tomorrow — YOUR Side"
                message = f"Sweeping TOMORROW on your side ({sides}, 8AM-12PM). Move tonight."
            else:
                status = "info"
                title = "Sweeping Tomorrow — Other Side"
                message = f"Sweeping tomorrow but on the {sides}. You're on the {'even' if car_side == 'even' else 'odd'} side at #{house_num}."
        elif sweep_events:
            status = "safe"
            title = "You're Good"
            next_sweep = sweep_events[0]
            message = f"Next sweep: {next_sweep['date']} ({next_sweep['side']} side, {next_sweep['time']})"
        else:
            status = "safe"
            title = "No Sweeping Scheduled"
            message = "No sweeping events found in the next 30 days."

        return {
            "found": True,
            "place_name": place_name,
            "place_id": place_id,
            "status": status,
            "title": title,
            "message": message,
            "sweep_events": sweep_events,
            "sweeping_today": sweeping_today,
            "sweeping_tomorrow": sweeping_tomorrow,
        }


class OAuthStartRequest(BaseModel):
    client_id: str
    redirect_uri: str
    scope: str = "openid offline_access vehicle_device_data vehicle_location"


class OAuthCallbackRequest(BaseModel):
    client_id: str
    client_secret: str
    redirect_uri: str
    code: str


@app.post("/api/oauth/start")
async def oauth_start(req: OAuthStartRequest):
    """Generate the Tesla OAuth authorization URL for the user to visit."""
    import secrets
    state = secrets.token_urlsafe(32)
    url = (
        f"https://auth.tesla.com/oauth2/v3/authorize"
        f"?response_type=code"
        f"&client_id={req.client_id}"
        f"&redirect_uri={req.redirect_uri}"
        f"&scope={req.scope.replace(' ', '+')}"
        f"&state={state}"
    )
    return {"url": url, "state": state}


@app.post("/api/oauth/callback")
async def oauth_callback(req: OAuthCallbackRequest):
    """Exchange authorization code for access token."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(
                "https://auth.tesla.com/oauth2/v3/token",
                json={
                    "grant_type": "authorization_code",
                    "client_id": req.client_id,
                    "client_secret": req.client_secret,
                    "code": req.code,
                    "redirect_uri": req.redirect_uri,
                },
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Tesla auth error: {e}")

        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Token exchange failed: {resp.text}")

        data = resp.json()
        return {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
            "token_type": data.get("token_type"),
        }


app.mount("/", StaticFiles(directory=".", html=True), name="static")

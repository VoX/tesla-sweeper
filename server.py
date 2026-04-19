"""Tesla Sweeper — FastAPI backend for proxying Tesla API calls and Recollect sweeping data."""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from typing import Optional
from pydantic import BaseModel
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
import httpx
import re
import secrets

app = FastAPI()
http = httpx.AsyncClient(timeout=15.0)

TESLA_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com"
NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
RECOLLECT_BASE = "https://api.recollect.net/api"
RECOLLECT_SERVICE = 349
UA = "TeslaSweeper/1.0"


async def proxy_get(url, **kwargs):
    try:
        return await http.get(url, **kwargs)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=str(e))


async def proxy_post(url, **kwargs):
    try:
        return await http.post(url, **kwargs)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=str(e))


class CheckRequest(BaseModel):
    token: str


class GeocodeRequest(BaseModel):
    lat: float
    lng: float


class SweepRequest(BaseModel):
    address: str
    tz_offset: Optional[int] = None


@app.post("/api/check")
async def check_vehicle(req: CheckRequest):
    headers = {"Authorization": f"Bearer {req.token}", "Content-Type": "application/json"}

    resp = await proxy_get(f"{TESLA_BASE}/api/1/vehicles", headers=headers)
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Invalid or expired Tesla token")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    vehicles = resp.json().get("response", [])
    if not vehicles:
        raise HTTPException(status_code=404, detail="No vehicles found on this account")

    vehicle = vehicles[0]
    loc_resp = await proxy_get(
        f"{TESLA_BASE}/api/1/vehicles/{vehicle['id']}/vehicle_data",
        params={"endpoints": "location_data"},
        headers=headers,
    )
    if loc_resp.status_code == 408:
        raise HTTPException(status_code=408, detail="Vehicle is asleep. Open the Tesla app to wake it, then retry.")
    if loc_resp.status_code != 200:
        raise HTTPException(status_code=loc_resp.status_code, detail=loc_resp.text)

    drive_state = loc_resp.json().get("response", {}).get("drive_state", {})
    lat, lng = drive_state.get("latitude"), drive_state.get("longitude")
    if lat is None or lng is None:
        raise HTTPException(status_code=404, detail="Could not determine vehicle location")

    return {"vehicle_name": vehicle.get("display_name", "Unknown"), "latitude": lat, "longitude": lng}


@app.post("/api/reverse-geocode")
async def reverse_geocode(req: GeocodeRequest):
    params = {"format": "jsonv2", "lat": req.lat, "lon": req.lng, "zoom": 18, "addressdetails": 1}
    resp = await proxy_get(f"{NOMINATIM_BASE}/reverse", params=params, headers={"User-Agent": UA})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Nominatim returned an error")

    address = resp.json().get("address", {})
    return {
        "street": address.get("road", ""),
        "house_number": address.get("house_number", ""),
        "city": address.get("city") or address.get("town") or address.get("village") or "",
        "state": address.get("state", ""),
        "display_name": resp.json().get("display_name", ""),
    }


@app.post("/api/sweep-check")
async def sweep_check(req: SweepRequest):
    if req.tz_offset is not None:
        today = datetime.now(timezone(timedelta(minutes=-req.tz_offset))).date()
    else:
        today = date.today()

    suggest_resp = await proxy_get(
        f"{RECOLLECT_BASE}/areas/Somerville/services/{RECOLLECT_SERVICE}/address-suggest",
        params={"q": req.address, "locale": "en-US"},
        headers={"User-Agent": UA},
    )
    if suggest_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Recollect address suggest error")

    suggestions = suggest_resp.json()
    if not suggestions:
        return {"found": False, "message": "Address not found in Somerville sweeping database"}

    place = suggestions[0]
    place_id = place["place_id"]

    events_resp = await proxy_get(
        f"{RECOLLECT_BASE}/places/{place_id}/services/{RECOLLECT_SERVICE}/events",
        params={"after": today.isoformat(), "before": (today + timedelta(days=30)).isoformat(), "locale": "en-US"},
        headers={"User-Agent": UA},
    )
    if events_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Recollect events error")

    events_data = events_resp.json()
    raw_events = events_data.get("events", events_data) if isinstance(events_data, dict) else events_data

    sweep_events = []
    for event in raw_events:
        for flag in event.get("flags", []):
            name = flag.get("name", "")
            if "sweeping" not in name.lower():
                continue
            time_match = re.search(r'(\d{1,2})(AM|PM)_(\d{1,2})(AM|PM)', name)
            time_str = f"{time_match.group(1)}:00 {time_match.group(2)} - {time_match.group(3)}:00 {time_match.group(4)}" if time_match else name
            sweep_events.append({
                "date": event.get("day", ""),
                "type": name,
                "side": "even" if "EVEN" in name else "odd" if "ODD" in name else "both",
                "time": time_str,
            })

    house_match = re.match(r'(\d+)', req.address.strip())
    house_num = int(house_match.group(1)) if house_match else None
    car_side = ("even" if house_num % 2 == 0 else "odd") if house_num else None

    today_str = today.isoformat()
    tomorrow_str = (today + timedelta(days=1)).isoformat()
    sweeping_today = [e for e in sweep_events if e["date"] == today_str]
    sweeping_tomorrow = [e for e in sweep_events if e["date"] == tomorrow_str]

    status, title, message = _sweep_status(sweeping_today, sweeping_tomorrow, sweep_events, car_side, house_num)

    return {
        "found": True,
        "place_name": place.get("name", req.address),
        "place_id": place_id,
        "status": status,
        "title": title,
        "message": message,
        "sweep_events": sweep_events,
        "car_side": car_side,
        "house_num": house_num,
    }


def _sweep_status(today_events, tomorrow_events, all_events, car_side, house_num):
    def side_label(events):
        return ", ".join(set(e["side"] + " side" for e in events))

    def car_matches(events):
        return not car_side or any(e["side"] == car_side for e in events)

    if today_events:
        sides = side_label(today_events)
        if car_matches(today_events):
            return "danger", "MOVE YOUR CAR", f"Sweeping TODAY on YOUR side ({sides}, 8AM-12PM). $50 fine!"
        return "warning", "Sweeping Today — Other Side", f"Sweeping today but on the {sides} (you're on the {car_side} side at #{house_num})."

    if tomorrow_events:
        sides = side_label(tomorrow_events)
        if car_matches(tomorrow_events):
            return "warning", "Sweeping Tomorrow — YOUR Side", f"Sweeping TOMORROW on your side ({sides}, 8AM-12PM). Move tonight."
        return "info", "Sweeping Tomorrow — Other Side", f"Sweeping tomorrow but on the {sides}. You're on the {car_side} side at #{house_num}."

    if all_events:
        e = all_events[0]
        return "safe", "You're Good", f"Next sweep: {e['date']} ({e['side']} side, {e['time']})"

    return "safe", "No Sweeping Scheduled", "No sweeping events found in the next 30 days."


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
    state = secrets.token_urlsafe(32)
    qs = urlencode({
        "response_type": "code",
        "client_id": req.client_id,
        "redirect_uri": req.redirect_uri,
        "scope": req.scope,
        "state": state,
    })
    return {"url": f"https://auth.tesla.com/oauth2/v3/authorize?{qs}", "state": state}


@app.post("/api/oauth/callback")
async def oauth_callback(req: OAuthCallbackRequest):
    resp = await proxy_post(
        "https://auth.tesla.com/oauth2/v3/token",
        json={
            "grant_type": "authorization_code",
            "client_id": req.client_id,
            "client_secret": req.client_secret,
            "code": req.code,
            "redirect_uri": req.redirect_uri,
        },
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()
    return {
        "access_token": data.get("access_token"),
        "refresh_token": data.get("refresh_token"),
        "expires_in": data.get("expires_in"),
        "token_type": data.get("token_type"),
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")

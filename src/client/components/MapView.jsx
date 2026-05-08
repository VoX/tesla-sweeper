import { useState, useEffect, useRef } from 'preact/hooks';
import { loadLeaflet } from '../leaflet-loader.js';

// Lazy-loaded Leaflet map. Recenters/redraws the marker when lat/lng
// change; in `draggable` mode wires `onPinMove(lat, lng)` to the marker
// dragend event. The green polyline + dashed red perpendicular line
// visualize the OSM-detected road segment from `whichSide()`.
export function MapView({ lat, lng, street, segment, draggable, onPinMove, popupLabel = 'Your Car' }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markerRef = useRef(null);
  const overlaysRef = useRef([]);
  const onPinMoveRef = useRef(onPinMove);
  const [L, setL] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Keep latest dragend handler in a ref so the marker's listener
  // (attached once at map init) always calls the current closure.
  useEffect(() => { onPinMoveRef.current = onPinMove; }, [onPinMove]);

  useEffect(() => {
    if (lat != null) loadLeaflet().then(setL).catch(e => setLoadError(e.message || 'Map failed to load'));
  }, [lat]);

  useEffect(() => () => {
    if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; markerRef.current = null; overlaysRef.current = []; }
  }, []);

  useEffect(() => {
    if (!L || !mapRef.current || lat == null) return;
    // Detect a stale instance: if we still hold a leaflet map but its
    // container DOM node was unmounted (parent dropped pos to null and
    // re-rendered us with a fresh div), the bound div is dead and any
    // setView/setLatLng would draw into nothing. Tear down so the
    // create branch below rebuilds against the live ref.
    if (mapInstance.current && mapInstance.current.getContainer() !== mapRef.current) {
      mapInstance.current.remove();
      mapInstance.current = null;
      markerRef.current = null;
      overlaysRef.current = [];
    }
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstance.current);
      markerRef.current = L.marker([lat, lng], { draggable: !!draggable }).addTo(mapInstance.current);
      if (draggable) {
        markerRef.current.on('dragend', () => {
          const ll = markerRef.current.getLatLng();
          onPinMoveRef.current?.(ll.lat, ll.lng);
        });
      }
    } else {
      mapInstance.current.setView([lat, lng], 17);
      markerRef.current.setLatLng([lat, lng]);
    }
    const popup = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = popupLabel;
    popup.appendChild(b);
    popup.appendChild(document.createElement('br'));
    popup.appendChild(document.createTextNode(street || 'Unknown'));
    markerRef.current.bindPopup(popup);
    if (!draggable) markerRef.current.openPopup();
  }, [L, lat, lng, street, draggable, popupLabel]);

  // Draw chosen road segment + perpendicular foot whenever segment changes.
  useEffect(() => {
    if (!L || !mapInstance.current) return;
    const map = mapInstance.current;
    overlaysRef.current.forEach(layer => map.removeLayer(layer));
    overlaysRef.current = [];
    if (!segment?.A || !segment?.B) return;
    overlaysRef.current.push(L.polyline([[segment.A.lat, segment.A.lng], [segment.B.lat, segment.B.lng]], { color: '#3fb950', weight: 4, opacity: 0.7 }).addTo(map));
    if (segment.foot && lat != null && lng != null) {
      overlaysRef.current.push(L.polyline([[segment.foot.lat, segment.foot.lng], [lat, lng]], { color: '#f85149', weight: 2, dashArray: '4 4' }).addTo(map));
    }
  }, [L, segment, lat, lng]);

  if (lat == null) return null;
  if (loadError) {
    return (
      <div className="map-container" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: '0.85rem', textAlign: 'center', padding: 16 }}>
        Map couldn't load ({loadError}). Refresh to retry.
      </div>
    );
  }
  return <div ref={mapRef} className="map-container" aria-label="Location map" role="img" />;
}

// Lazy-load leaflet so the 152 KB chunk only ships when the user
// actually renders a map (sweep result or test-side panel). Cached
// after first load — subsequent calls return the resolved promise.
let leafletPromise = null;

export function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    const [Lmod, icon2x, icon, shadow] = await Promise.all([
      import('leaflet'),
      import('leaflet/dist/images/marker-icon-2x.png'),
      import('leaflet/dist/images/marker-icon.png'),
      import('leaflet/dist/images/marker-shadow.png'),
      import('leaflet/dist/leaflet.css'),
    ]);
    const L = Lmod.default || Lmod;
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconUrl: icon.default || icon,
      iconRetinaUrl: icon2x.default || icon2x,
      shadowUrl: shadow.default || shadow,
    });
    return L;
  })();
  return leafletPromise;
}

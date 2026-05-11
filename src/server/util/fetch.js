// Shared fetch wrapper with a 12s upstream timeout. Every integration +
// route module that talks to a third-party API uses this so we don't
// hang a worker on a slow Tesla/Slack/OSM round-trip.

// Per OSM Nominatim policy: User-Agent must identify the app + provide
// a contact URL so the maintainers can reach us on abuse.
export const UA = 'TeslaSweeper/1.0 (+https://sweeper.bitvox.me/)';
const FETCH_TIMEOUT = 12000;

export const fetchWithTimeout = (url, options = {}) =>
  fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });

// Shared fetch wrapper with a 12s upstream timeout. Every integration +
// route module that talks to a third-party API uses this so we don't
// hang a worker on a slow Tesla/Slack/OSM round-trip.

export const UA = 'TeslaSweeper/1.0';
export const FETCH_TIMEOUT = 12000;

export const fetchWithTimeout = (url, options = {}) =>
  fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });

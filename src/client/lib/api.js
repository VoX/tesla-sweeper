// Thin wrapper over fetch for the SPA's POST + GET API calls.
// Same-origin under sweeper.bitvox.me — no path-prefix dance.

const API = '/api';

async function handleRes(res) {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: 'API error' }));
    // Attach status so callers can branch on 401 without string-matching
    // the detail message (which the server controls and changes).
    const err = new Error(e.detail || 'API error');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function post(url, body, signal) {
  return handleRes(await fetch(`${API}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }));
}

export async function get(url) { return handleRes(await fetch(`${API}/${url}`)); }

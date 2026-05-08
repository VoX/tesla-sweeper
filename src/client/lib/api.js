// Thin wrapper over fetch for the SPA's POST + GET API calls.
// Pulls all `/sweeper/api` traffic in one place so the dev/prod URL
// switch lives in exactly one constant.

const API = import.meta.env.DEV ? '/sweeper/api' : 'api';

async function handleRes(res) {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ detail: 'API error' }));
    throw new Error(e.detail || 'API error');
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

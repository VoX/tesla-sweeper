import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';

// Mock the lazy leaflet loader so MapView can render in tests without
// hitting the real Leaflet dynamic import.
vi.mock('../leaflet-loader.js', () => ({
  loadLeaflet: () => new Promise(() => {}),
}));

const realFetch = globalThis.fetch;

// A URL-routing fetch mock. Each test sets `routes` (a map of
// url-substring → response body); `me` defaults to "not authenticated".
let routes;
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
function installFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) return typeof body === 'function' ? body() : okJson(body);
    }
    // Unmatched (e.g. /reverse-geocode if an auto-check slips through) —
    // hang so it never resolves into an assertion.
    return new Promise(() => {});
  });
}

beforeEach(() => {
  routes = { 'session/me': { authenticated: false } };
  installFetch();
  localStorage.clear();
  sessionStorage.clear();
  // Default URL — App reads window.location for the tab query param +
  // the OAuth callback `code`. happy-dom lets us mutate this freely.
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

async function renderApp() {
  const App = (await import('../App.jsx')).default;
  const out = render(<App />);
  await tick();
  return out;
}

describe('App', () => {
  it('asks /api/session/me on mount and shows the Tesla connect button when unauthenticated', async () => {
    const { container } = await renderApp();
    // /api/session/me was the mount probe.
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('session/me'))).toBe(true);
    // No /api/vehicles fetch since the session probe came back unauthenticated.
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('/api/vehicles'))).toBe(false);
    const connectBtn = Array.from(container.querySelectorAll('button')).find(
      b => /connect|sign in/i.test(b.textContent)
    );
    expect(connectBtn).toBeTruthy();
  });

  it('adopts the session when /api/session/me reports authenticated, then fetches vehicles', async () => {
    routes = {
      'session/me': { authenticated: true, slack_user_id: null, vehicle_id: null, vehicle_name: null },
      '/api/vehicles': { vehicles: [] },
    };
    const { container } = await renderApp();
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('/api/vehicles'))).toBe(true);
    // Connected view: the "Disconnect" button is present, the "Connect" one isn't.
    const btns = Array.from(container.querySelectorAll('button')).map(b => b.textContent);
    expect(btns.some(t => /disconnect/i.test(t))).toBe(true);
    expect(btns.some(t => /connect tesla/i.test(t))).toBe(false);
  });

  it('renders is_stub vehicles with a "(test)" badge in the picker', async () => {
    routes = {
      'session/me': { authenticated: true, slack_user_id: null, vehicle_id: null, vehicle_name: null },
      '/api/vehicles': { vehicles: [
        { id: '111', name: 'Real Car', vin: 'V1', state: 'asleep' },
        { id: '999999999999999', name: 'Test Vehicle', vin: 'V2', state: 'online', is_stub: true },
      ] },
    };
    const { container } = await renderApp();
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    const opts = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    expect(opts.some(t => t.includes('Real Car') && !t.includes('(test)'))).toBe(true);
    expect(opts.some(t => t.includes('Test Vehicle (test)'))).toBe(true);
  });

  it('returning from a Slack OAuth redirect: clears the "Exchanging…" status, bootstraps the Tesla session, and adopts the OIDC-verified slack id (not /session/me\'s)', async () => {
    sessionStorage.setItem('slack_oauth_state', 'SSTATE');
    window.history.replaceState({}, '', '/oauth?code=SCODE&state=SSTATE');
    routes = {
      'slack/oauth/callback': { slack_user_id: 'U060NLFUM', name: 'Kit', session: 'sess-abc' },
      // The record reports a *different* slack id — adoptSlackId=false must
      // keep this from clobbering the freshly-verified one above.
      'session/me': { authenticated: true, slack_user_id: 'USTALE000', vehicle_id: null, vehicle_name: null },
      '/api/vehicles': { vehicles: [] },
      'notifications/status': { subscriptions: [] },
    };
    const { container } = await renderApp();
    // Slack callback was exchanged.
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('slack/oauth/callback'))).toBe(true);
    // "Exchanging slack code for identity…" must not still be on screen.
    expect(container.textContent).not.toMatch(/exchanging slack code/i);
    // Tesla session bootstrapped despite the Slack-branch early return:
    // connected view, not the "Connect Tesla Account" button.
    const btns = Array.from(container.querySelectorAll('button')).map(b => b.textContent);
    expect(btns.some(t => /disconnect/i.test(t))).toBe(true);
    expect(btns.some(t => /connect tesla/i.test(t))).toBe(false);
    // slackUserId came from the callback (U060NLFUM), not the record
    // (USTALE000) — proven by the subscriptions fetch firing for it
    // (only happens when loggedIn && slackUserId are both set).
    const statusCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('notifications/status'));
    expect(statusCall).toBeTruthy();
    expect(String(statusCall[0])).toContain('U060NLFUM');
  });

  it('Enable Daily Notifications is disabled (and posts nothing) until you sign in with Slack', async () => {
    routes = {
      'session/me': { authenticated: true, slack_user_id: null, vehicle_id: null, vehicle_name: null },
      '/api/vehicles': { vehicles: [{ id: '111', name: 'Car', vin: 'V', state: 'asleep' }] },
      'notifications/status': { subscriptions: [] },
    };
    const { container } = await renderApp();
    // No manual slack-id field — the id comes only from "Sign in with Slack".
    expect(container.querySelector('#slack-user-id')).toBeNull();
    const enableBtn = Array.from(container.querySelectorAll('button')).find(b => /enable daily/i.test(b.textContent));
    expect(enableBtn).toBeTruthy();
    expect(enableBtn.disabled).toBe(true);
    const callsBefore = globalThis.fetch.mock.calls.length;
    fireEvent.click(enableBtn);
    await tick(10);
    const enableCalls = globalThis.fetch.mock.calls.slice(callsBefore).filter(([url]) => String(url).includes('notifications/enable'));
    expect(enableCalls.length).toBe(0);
  });
});

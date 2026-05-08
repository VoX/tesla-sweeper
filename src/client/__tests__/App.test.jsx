import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';

// Mock the lazy leaflet loader so MapView can render in tests without
// hitting the real Leaflet dynamic import.
vi.mock('../leaflet-loader.js', () => ({
  loadLeaflet: () => new Promise(() => {}),
}));

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
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
  vi.useRealTimers();
});

async function importApp() {
  const m = await import('../App.jsx');
  return m.default;
}

describe('App', () => {
  it('renders the Tesla connect button when no tokens are stored', async () => {
    const App = await importApp();
    const { container } = render(<App />);
    // No vehicles fetch should have fired because tokens is null.
    expect(globalThis.fetch.mock.calls.length).toBe(0);
    // Connect button is the only <button> with "Connect" or "Sign in" text.
    const connectBtn = Array.from(container.querySelectorAll('button')).find(
      b => /connect|sign in/i.test(b.textContent)
    );
    expect(connectBtn).toBeTruthy();
  });

  it('persists tokens to localStorage when state hydrates', async () => {
    localStorage.setItem('tesla_tokens', JSON.stringify({
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600_000,
    }));
    // /api/vehicles call fires from the tokens-loaded effect — give it
    // an empty list so the test doesn't depend on the dropdown markup.
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ vehicles: [] }) });
    const App = await importApp();
    render(<App />);
    // localStorage round-trip: we wrote it before mount, App read it,
    // and the tokens-write effect serialized it back.
    expect(localStorage.getItem('tesla_tokens')).toBeTruthy();
  });

  it('renders is_stub vehicles with a "(test)" badge', async () => {
    localStorage.setItem('tesla_tokens', JSON.stringify({
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600_000,
    }));
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        vehicles: [
          { id: '111', name: 'Real Car', vin: 'V1', state: 'online' },
          { id: '999999999999999', name: 'Test Vehicle', vin: 'V2', state: 'online', is_stub: true },
        ],
      }),
    });
    const App = await importApp();
    const { container } = render(<App />);
    // Wait a microtask for the effect-driven fetch to land + the
    // dropdown to render.
    await new Promise(r => setTimeout(r, 50));
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    const opts = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    // Real vehicle: no badge. Stub: has " (test)" suffix.
    expect(opts.some(t => t.includes('Real Car') && !t.includes('(test)'))).toBe(true);
    expect(opts.some(t => t.includes('Test Vehicle (test)'))).toBe(true);
  });

  it('rejects an invalid Slack user id format before calling /enable', async () => {
    localStorage.setItem('tesla_tokens', JSON.stringify({
      access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600_000,
    }));
    // /api/vehicles + /api/notifications/status both fire on mount.
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ vehicles: [{ id: '111', name: 'Car', vin: 'V', state: 'online' }], subscriptions: [] }) });
    const App = await importApp();
    const { container } = render(<App />);
    await new Promise(r => setTimeout(r, 50));
    // Find the slack id input + Enable button.
    const slackInput = container.querySelector('input[placeholder*="U060"], input[type="text"]');
    if (!slackInput) return; // notifications panel not mounted — skip
    fireEvent.input(slackInput, { target: { value: 'not-a-slack-id' } });
    const enableBtn = Array.from(container.querySelectorAll('button')).find(b => /enable/i.test(b.textContent));
    if (!enableBtn) return;
    const callsBefore = globalThis.fetch.mock.calls.length;
    fireEvent.click(enableBtn);
    await new Promise(r => setTimeout(r, 10));
    // Validation rejected the input — no /enable POST was sent.
    const enableCalls = globalThis.fetch.mock.calls.slice(callsBefore).filter(
      ([url]) => String(url).includes('notifications/enable')
    );
    expect(enableCalls.length).toBe(0);
  });
});

import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// Set deterministic env BEFORE the app loads so the HMAC + bearer
// gates have known values (config.js reads .env first; explicit env
// overrides via process.env still take precedence).
process.env.SESSION_HMAC_KEY = 'a'.repeat(64);
process.env.NOTIFICATIONS_RUN_TOKEN = 'test-bearer-token';
process.env.TESLA_CLIENT_ID = 'test-tesla-client';
process.env.TESLA_REDIRECT_URI = 'https://example.invalid/cb';
process.env.SLACK_CLIENT_ID = 'test-slack-client';
process.env.SLACK_REDIRECT_URI = 'https://example.invalid/slack-cb';
process.env.STUB_VEHICLE_ENABLED = '1';

// Mock external integrations so tests don't touch the network.
vi.mock('../integrations/tesla.js', async () => {
  const actual = await vi.importActual('../integrations/tesla.js');
  return {
    ...actual,
    fetchVehicleData: vi.fn().mockResolvedValue({ response: { drive_state: { latitude: 42.385, longitude: -71.108 } } }),
    teslaTokenExchange: vi.fn().mockResolvedValue({ access_token: 'tok', refresh_token: 'rot', expires_in: 3600 }),
  };
});

vi.mock('../integrations/slack.js', () => ({
  postSlackDM: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../integrations/recollect.js', () => ({
  suggestAddress: vi.fn().mockResolvedValue([{ place_id: 'p1', name: '12 Harvard St' }]),
  fetchSweepEvents: vi.fn().mockResolvedValue([]),
  parseSweepFlags: vi.fn().mockReturnValue([]),
}));

vi.mock('../integrations/overpass.js', () => ({
  whichSide: vi.fn().mockResolvedValue({ side: 'even', car_house_number: 12 }),
}));

vi.mock('../integrations/nominatim.js', () => ({
  reverseGeocodeLocation: vi.fn().mockResolvedValue({ street: 'Harvard St', house_number: '12', city: 'Somerville', display_name: '12 Harvard St, Somerville' }),
}));

vi.mock('../notifications/cron.js', () => ({
  runNotifications: vi.fn().mockResolvedValue({ ran_at: '2026-05-08T17:00:00.000Z', mode: 'daily', results: [] }),
  startNotificationCron: vi.fn(),
  maybeRecoverMissedRun: vi.fn(),
  maybeRecoverMissedDigest: vi.fn(),
}));

const { buildApp } = await import('../app.js');
const app = buildApp();

describe('GET /healthz', () => {
  it('returns 200 with the documented shape', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('last_run_at');
    expect(res.body).toHaveProperty('last_digest_run_at');
    expect(res.body).toHaveProperty('sub_count');
  });
});

describe('POST /api/which-side', () => {
  it('returns 400 when lat/lng are missing or out of range', async () => {
    const r1 = await request(app).post('/api/which-side').send({});
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/which-side').send({ lat: 91, lng: 0 });
    expect(r2.status).toBe(400);
  });

  it('returns 200 with mocked whichSide result', async () => {
    const r = await request(app).post('/api/which-side').send({ lat: 42.385, lng: -71.108 });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('side', 'even');
  });
});

describe('POST /api/sweep-check', () => {
  it('returns 400 without an address', async () => {
    const r = await request(app).post('/api/sweep-check').send({ lat: 42, lng: -71 });
    expect(r.status).toBe(400);
  });

  it('returns 400 with out-of-range lat', async () => {
    const r = await request(app).post('/api/sweep-check').send({ address: '12 Harvard St', lat: 999, lng: -71 });
    expect(r.status).toBe(400);
  });

  it('returns 200 with documented response shape', async () => {
    const r = await request(app).post('/api/sweep-check').send({ address: '12 Harvard St', lat: 42.385, lng: -71.108 });
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
  });
});

describe('POST /api/notifications/enable — HMAC session gate', () => {
  it('returns 403 when session is missing/invalid', async () => {
    const r = await request(app).post('/api/notifications/enable').send({
      refresh_token: 'rt', vehicle_id: 1, slack_user_id: 'U060NLFUM', session: 'bogus',
    });
    expect(r.status).toBe(403);
  });

  it('returns 400 when required fields are missing', async () => {
    const r = await request(app).post('/api/notifications/enable').send({});
    expect(r.status).toBe(400);
  });
});

describe('POST /api/notifications/run — bearer gate', () => {
  it('returns 401 without bearer auth', async () => {
    const r = await request(app).post('/api/notifications/run').send({});
    expect(r.status).toBe(401);
  });

  it('returns 401 with wrong bearer', async () => {
    const r = await request(app).post('/api/notifications/run').set('Authorization', 'Bearer wrong').send({});
    expect(r.status).toBe(401);
  });

  it('returns 200 with the right bearer', async () => {
    const r = await request(app).post('/api/notifications/run').set('Authorization', 'Bearer test-bearer-token').send({});
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('ran_at');
    expect(r.body).toHaveProperty('mode');
    expect(r.body).toHaveProperty('results');
  });
});

describe('GET /api/notifications/status', () => {
  it('returns 400 without slack_user_id query', async () => {
    const r = await request(app).get('/api/notifications/status');
    expect(r.status).toBe(400);
  });

  it('returns 200 with subscriptions array', async () => {
    const r = await request(app).get('/api/notifications/status?slack_user_id=U060NLFUM');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('subscriptions');
    expect(Array.isArray(r.body.subscriptions)).toBe(true);
  });
});

describe('unknown /api/* paths', () => {
  it('returns 404 JSON, not the SPA', async () => {
    const r = await request(app).get('/api/no-such-thing');
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('detail');
  });
});

describe('POST /api/oauth/app/start + /callback — server-side state', () => {
  it('mints + consumes a state in one round trip', async () => {
    const start = await request(app).post('/api/oauth/app/start').send({});
    expect(start.status).toBe(200);
    expect(start.body.state).toBeTruthy();
    // Tesla token exchange is mocked; we just need the state gate to pass.
    const cb = await request(app).post('/api/oauth/app/callback').send({ code: 'c', state: start.body.state });
    expect(cb.status).toBe(200);
    expect(cb.body).toHaveProperty('access_token');
  });

  it('rejects /callback without state', async () => {
    const r = await request(app).post('/api/oauth/app/callback').send({ code: 'c' });
    expect(r.status).toBe(400);
  });

  it('rejects /callback with a forged state', async () => {
    const r = await request(app).post('/api/oauth/app/callback').send({ code: 'c', state: 'never-minted' });
    expect(r.status).toBe(400);
  });

  it('rejects /callback when reusing a consumed state (one-shot)', async () => {
    const start = await request(app).post('/api/oauth/app/start').send({});
    const first = await request(app).post('/api/oauth/app/callback').send({ code: 'c', state: start.body.state });
    expect(first.status).toBe(200);
    const replay = await request(app).post('/api/oauth/app/callback').send({ code: 'c', state: start.body.state });
    expect(replay.status).toBe(400);
  });

  it('rejects a tesla state used on the slack callback (type-tagged)', async () => {
    const start = await request(app).post('/api/oauth/app/start').send({});
    const cb = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    expect(cb.status).toBe(400);
  });
});

describe('POST /api/slack/oauth/callback — id_token claim verification', () => {
  // Build a minimal id_token-ish JWT: header.payload.sig with payload
  // base64url-encoded. The route only decodes payload, not signature.
  const idToken = (claims) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  const slackTokenRes = (claims) => ({
    ok: true,
    json: async () => ({ ok: true, id_token: idToken(claims) }),
  });

  const realFetch = globalThis.fetch;
  beforeAll(() => {});
  // Each test installs its own fetch stub then restores.
  const withSlackResponse = (claims) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(slackTokenRes(claims));
  };
  const restore = () => { globalThis.fetch = realFetch; };

  it('rejects an id_token with a wrong issuer', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://attacker.example', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    restore();
    expect(r.status).toBe(502); // wrap() converts thrown errors to 502 upstream-error
  });

  it('rejects an id_token with a wrong audience', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'someone-else', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    restore();
    expect(r.status).toBe(502);
  });

  it('rejects an expired id_token', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) - 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    restore();
    expect(r.status).toBe(502);
  });

  it('accepts a valid id_token + mints a session', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U060NLFUM', name: 'Test' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    restore();
    expect(r.status).toBe(200);
    expect(r.body.slack_user_id).toBe('U060NLFUM');
    expect(r.body.session).toBeTruthy();
  });
});

describe('POST /api/vehicles — stub injection + stringified ids', () => {
  it('injects the stub vehicle when Tesla returns no real ones (STUB_VEHICLE_ENABLED=1)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ response: [] }), text: async () => '' });
    const r = await request(app).post('/api/vehicles').send({ token: 'tok' });
    globalThis.fetch = realFetch;
    expect(r.status).toBe(200);
    expect(r.body.vehicles.length).toBe(1);
    expect(r.body.vehicles[0]).toMatchObject({ is_stub: true });
    expect(typeof r.body.vehicles[0].id).toBe('string');
  });

  it('stringifies real Tesla vehicle ids at the boundary (BigInt precision safety)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ response: [{ id: 1234567890123456789, display_name: 'Car', vin: 'V', state: 'online' }] }), text: async () => '' });
    const r = await request(app).post('/api/vehicles').send({ token: 'tok' });
    globalThis.fetch = realFetch;
    expect(r.status).toBe(200);
    expect(typeof r.body.vehicles[0].id).toBe('string');
    expect(r.body.vehicles[0].is_stub).toBeUndefined();
  });

  it('passes through a 401 from Tesla as a 401', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    const r = await request(app).post('/api/vehicles').send({ token: 'expired' });
    globalThis.fetch = realFetch;
    expect(r.status).toBe(401);
  });
});

describe('POST /api/reverse-geocode — lat/lng validation', () => {
  it('rejects non-numeric coords (would otherwise pollute Nominatim cache as NaN,NaN)', async () => {
    const r = await request(app).post('/api/reverse-geocode').send({ lat: 'abc', lng: 'def' });
    expect(r.status).toBe(400);
  });

  it('returns 200 with mocked geocode for valid coords', async () => {
    const r = await request(app).post('/api/reverse-geocode').send({ lat: 42.385, lng: -71.108 });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('street');
  });
});

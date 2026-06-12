import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the user store at a throwaway dir BEFORE any import that loads
// store/users.js (probesRouter + notificationsRouter both do, and that
// module runs its legacy-migration at import time). Without this, a
// fresh-clone `npm test` would migrate the real data/ dir.
process.env.SWEEPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-routes-test-'));

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
  it('returns 401 with no proof at all (no session, no cookie)', async () => {
    const r1 = await request(app).get('/api/notifications/status');
    expect(r1.status).toBe(401);
    const r2 = await request(app).get('/api/notifications/status?slack_user_id=U060NLFUM');
    expect(r2.status).toBe(401);
  });

  it('returns 200 with subscriptions array when the session is valid', async () => {
    const { signSession } = await import('../crypto/session.js');
    const sess = encodeURIComponent(signSession('U060NLFUM'));
    const r = await request(app).get(`/api/notifications/status?slack_user_id=U060NLFUM&slack_session=${sess}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('subscriptions');
    expect(Array.isArray(r.body.subscriptions)).toBe(true);
  });

  it('falls back to the Tesla session cookie and returns the cookie-bound sub (expired-Slack-session UX)', async () => {
    const { createUser, blankUser, deleteUser } = await import('../store/users.js');
    const { signOpaque } = await import('../crypto/session.js');
    const u = createUser(blankUser({
      session_cookie_id: 'sid-status-test', slack_user_id: 'U0COOKIE',
      vehicle_id: '42', vehicle_name: 'CookieCar',
    }));
    try {
      const r = await request(app).get('/api/notifications/status')
        .set('Cookie', `session=${signOpaque('sid-status-test')}`);
      expect(r.status).toBe(200);
      expect(r.body.subscriptions).toHaveLength(1);
      expect(r.body.subscriptions[0].slack_user_id).toBe('U0COOKIE');
      // and a cookie-bound record WITHOUT an active sub yields an empty list
    } finally {
      deleteUser(u.id);
    }
  });
});

describe('POST /api/notifications/disable — dual ownership gate', () => {
  it('returns 403 with no proof at all', async () => {
    const r = await request(app).post('/api/notifications/disable').send({ id: 'some-id' });
    expect(r.status).toBe(403);
  });

  it('accepts the Tesla session cookie for the record it is bound to', async () => {
    const { createUser, blankUser, loadUserById } = await import('../store/users.js');
    const { signOpaque } = await import('../crypto/session.js');
    const u = createUser(blankUser({
      session_cookie_id: 'sid-disable-test', slack_user_id: 'U0COOKIE',
      vehicle_id: '42', vehicle_name: 'CookieCar',
    }));
    const r = await request(app).post('/api/notifications/disable')
      .set('Cookie', `session=${signOpaque('sid-disable-test')}`)
      .send({ id: u.id });
    expect(r.status).toBe(200);
    expect(r.body.disabled).toBe(true);
    // record kept (browser still bound) but the sub fields are cleared
    expect(loadUserById(u.id).slack_user_id).toBeNull();
  });

  it('rejects a cookie bound to a DIFFERENT record (no cross-record disable)', async () => {
    const { createUser, blankUser, deleteUser } = await import('../store/users.js');
    const { signOpaque } = await import('../crypto/session.js');
    const victim = createUser(blankUser({ slack_user_id: 'U0VICTIM', vehicle_id: '7' }));
    const attacker = createUser(blankUser({ session_cookie_id: 'sid-attacker' }));
    try {
      const r = await request(app).post('/api/notifications/disable')
        .set('Cookie', `session=${signOpaque('sid-attacker')}`)
        .send({ id: victim.id });
      expect(r.status).toBe(403);
    } finally {
      deleteUser(victim.id); deleteUser(attacker.id);
    }
  });

  it('still accepts the Slack HMAC session with no cookie (lapsed-Tesla escape hatch)', async () => {
    const { createUser, blankUser } = await import('../store/users.js');
    const { signSession } = await import('../crypto/session.js');
    const u = createUser(blankUser({ slack_user_id: 'U0HMAC', vehicle_id: '9', vehicle_name: 'HmacCar' }));
    const r = await request(app).post('/api/notifications/disable')
      .send({ id: u.id, slack_user_id: 'U0HMAC', slack_session: signSession('U0HMAC') });
    expect(r.status).toBe(200);
    expect(r.body.disabled).toBe(true);
  });
});

describe('unknown /api/* paths', () => {
  it('returns 404 JSON, not the SPA', async () => {
    const r = await request(app).get('/api/no-such-thing');
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('detail');
  });
});

describe('POST /api/oauth/app/start + the shared state registry', () => {
  // The Tesla code exchange + state-consumption live in /api/session/create
  // now (covered by session-routes.test.js). Here we just check /start
  // mints a state and that states are type-tagged across the two flows.
  it('mints a state', async () => {
    const r = await request(app).post('/api/oauth/app/start').send({});
    expect(r.status).toBe(200);
    expect(r.body.state).toBeTruthy();
    expect(r.body.url).toContain('auth.tesla.com');
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
  const withSlackResponse = (claims) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(slackTokenRes(claims));
  };
  afterEach(() => { globalThis.fetch = realFetch; });

  it('rejects an id_token with a wrong issuer', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://attacker.example', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    expect(r.status).toBe(502); // wrap() converts thrown errors to 502 upstream-error
  });

  it('rejects an id_token with a wrong audience', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'someone-else', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    expect(r.status).toBe(502);
  });

  it('rejects an expired id_token', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) - 60, 'https://slack.com/user_id': 'U1' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    expect(r.status).toBe(502);
  });

  it('accepts a valid id_token + mints a session', async () => {
    const start = await request(app).post('/api/slack/oauth/start').send({});
    withSlackResponse({ iss: 'https://slack.com', aud: 'test-slack-client', exp: Math.floor(Date.now()/1000) + 60, 'https://slack.com/user_id': 'U060NLFUM', name: 'Test' });
    const r = await request(app).post('/api/slack/oauth/callback').send({ code: 'c', state: start.body.state });
    expect(r.status).toBe(200);
    expect(r.body.slack_user_id).toBe('U060NLFUM');
    expect(r.body.session).toBeTruthy();
  });
});

// /api/vehicles cookie-path coverage (stub injection, BigInt-safe id
// stringification, 401 passthrough) lives in session-routes.test.js. The
// legacy `token` body path was dropped in Phase 8.

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

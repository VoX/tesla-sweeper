import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

// Real on-disk store in a throwaway dir + a deterministic HMAC key,
// both set BEFORE any import that transitively reads them at module
// eval time (store/users.js → SWEEPER_DATA_DIR + migrateLegacy;
// crypto/session.js → SESSION_HMAC_KEY).
process.env.SWEEPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-session-test-'));
process.env.SESSION_HMAC_KEY = 'b'.repeat(64);
process.env.TESLA_CLIENT_ID = 'test-client';
process.env.TESLA_CLIENT_SECRET = 'test-secret';
process.env.TESLA_REDIRECT_URI = 'https://sweeper.bitvox.me/oauth';

const { buildApp } = await import('../app.js');
const { saveStore, loadUsers, loadUserByTeslaAccountId, createUser, blankUser, patchUser } = await import('../store/users.js');
const { mintState, _resetStateStore } = await import('../util/oauth-state.js');

const app = buildApp();

// --- fetch mock: routes Tesla calls by URL; per-test responses via the
// mutable `let`s below (reset in beforeEach). ---------------------------
const makeIdToken = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const goodTokenBody = () => ({
  access_token: 'AT_live', refresh_token: 'RT_live', expires_in: 28800, token_type: 'Bearer',
  id_token: makeIdToken({ sub: 'acct-default', exp: Math.floor(Date.now() / 1000) + 3600 }),
});

let tokenResponse, vehiclesResponse, usersMeResponse;
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const revokeCalls = [];

beforeAll(() => {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('/oauth2/v3/token')) return tokenResponse;
    if (u.includes('/oauth2/v3/revoke')) { revokeCalls.push({ url: u, body: opts?.body?.toString() }); return okJson({}); }
    if (u.includes('/api/1/vehicles')) return vehiclesResponse;
    if (u.includes('/api/1/users/me')) return usersMeResponse;
    throw new Error(`unexpected fetch in test: ${u}`);
  });
});

beforeEach(() => {
  saveStore({ users: [] });
  _resetStateStore();
  revokeCalls.length = 0;
  vi.clearAllMocks();
  tokenResponse = okJson(goodTokenBody());
  vehiclesResponse = okJson({ response: [{ id: 1234567890123456, display_name: 'My Tesla', vin: 'VIN1', state: 'online' }] });
  usersMeResponse = okJson({ response: { vault_uuid: 'vault-from-me', email: 'k@example.com' } });
});

const sessionValue = (res) => res.headers['set-cookie'][0].split(';')[0]; // "session=<signed>"

describe('POST /api/session/create', () => {
  it('exchanges a code, creates a user record, sets a signed cookie, returns vehicles', async () => {
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ code: 'oauth-code', state });
    expect(res.status).toBe(200);
    expect(res.body.vehicles).toEqual([{ id: '1234567890123456', name: 'My Tesla', vin: 'VIN1', state: 'online' }]);
    // Cookie attributes.
    const setCookie = res.headers['set-cookie'][0];
    expect(setCookie).toMatch(/^session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // Persisted record: token owned server-side, account id keyed, cookie bound.
    const users = loadUsers();
    expect(users).toHaveLength(1);
    expect(users[0].tesla_account_id).toBe('acct-default');
    expect(users[0].refresh_token).toBe('RT_live');
    expect(users[0].access_token).toBe('AT_live');
    expect(users[0].session_cookie_id).toBeTruthy();
    expect(users[0].refresh_invalidated_at).toBeNull();
  });

  it('reuses an existing record matched by tesla_account_id (no duplicate)', async () => {
    createUser(blankUser({
      tesla_account_id: 'acct-default', refresh_token: 'RT_old', slack_user_id: 'U060NLFUM',
      vehicle_id: '999', vehicle_name: 'Old Name',
    }));
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(res.status).toBe(200);
    const users = loadUsers();
    expect(users).toHaveLength(1); // reused, not duplicated
    expect(users[0].refresh_token).toBe('RT_live'); // new token persisted
    expect(users[0].slack_user_id).toBe('U060NLFUM'); // sub fields untouched
    expect(users[0].vehicle_id).toBe('999');
  });

  it('clears a stale refresh_invalidated_at when a fresh token lands on the record', async () => {
    createUser(blankUser({ tesla_account_id: 'acct-default', refresh_token: 'RT_dead', refresh_invalidated_at: '2026-01-01T00:00:00.000Z' }));
    const state = mintState('tesla');
    await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(loadUserByTeslaAccountId('acct-default').refresh_invalidated_at).toBeNull();
  });

  it('falls back to /api/1/users/me when the id_token has no usable sub', async () => {
    tokenResponse = okJson({ access_token: 'AT', refresh_token: 'RT', expires_in: 28800, token_type: 'Bearer' }); // no id_token
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(res.status).toBe(200);
    expect(loadUsers()[0].tesla_account_id).toBe('vault-from-me');
  });

  it('rejects a missing code with 400', async () => {
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ state });
    expect(res.status).toBe(400);
    expect(loadUsers()).toHaveLength(0);
  });

  it('rejects a missing/never-minted/replayed state with 400', async () => {
    const state = mintState('tesla');
    expect((await request(app).post('/api/session/create').send({ code: 'c' })).status).toBe(400);
    expect((await request(app).post('/api/session/create').send({ code: 'c', state: 'forged' })).status).toBe(400);
    const first = await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(first.status).toBe(200);
    const replay = await request(app).post('/api/session/create').send({ code: 'c', state }); // one-shot
    expect(replay.status).toBe(400);
  });

  it('502s on an incomplete token set (2xx but no access/refresh token)', async () => {
    tokenResponse = okJson({ token_type: 'Bearer' });
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(res.status).toBe(502);
    expect(loadUsers()).toHaveLength(0);
  });

  it('502s (but still sets the cookie) when the post-login vehicle list fetch fails', async () => {
    vehiclesResponse = { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    const state = mintState('tesla');
    const res = await request(app).post('/api/session/create').send({ code: 'c', state });
    expect(res.status).toBe(502);
    expect(res.headers['set-cookie'][0]).toMatch(/^session=/); // logged in despite the list failure
    expect(loadUsers()).toHaveLength(1);
  });
});

describe('GET /api/session/me', () => {
  it('returns authenticated:false with no cookie', async () => {
    const res = await request(app).get('/api/session/me');
    expect(res.body).toEqual({ authenticated: false, slack_user_id: null, vehicle_id: null, vehicle_name: null });
  });

  it('returns authenticated:false on a forged/tampered cookie', async () => {
    const state = mintState('tesla');
    const created = await request(app).post('/api/session/create').send({ code: 'c', state });
    const signed = sessionValue(created).slice('session='.length);
    // Flip the first base64url char of the sid — full 6 meaningful bits
    // there, so the decoded value definitely changes (unlike the last
    // char, which has 2 don't-care padding bits in a 32-byte digest).
    const tampered = 'session=' + (signed[0] === 'A' ? 'B' : 'A') + signed.slice(1);
    const res = await request(app).get('/api/session/me').set('Cookie', tampered);
    expect(res.body.authenticated).toBe(false);
  });

  it('returns the sub fields for a valid cookie', async () => {
    const state = mintState('tesla');
    const created = await request(app).post('/api/session/create').send({ code: 'c', state });
    // Simulate a /enable having populated the sub fields on the bound record.
    patchUser(loadUsers()[0].id, { slack_user_id: 'U060NLFUM', vehicle_id: '1234567890123456', vehicle_name: 'My Tesla' });
    const res = await request(app).get('/api/session/me').set('Cookie', sessionValue(created));
    expect(res.body).toEqual({ authenticated: true, slack_user_id: 'U060NLFUM', vehicle_id: '1234567890123456', vehicle_name: 'My Tesla' });
  });
});

describe('POST /api/session/destroy', () => {
  it('unbinds the cookie and clears it; is idempotent with no cookie', async () => {
    const noCookie = await request(app).post('/api/session/destroy');
    expect(noCookie.status).toBe(204);
    expect(noCookie.headers['set-cookie'][0]).toMatch(/^session=;/); // cleared
  });

  it('orphaned record (no sub): unbinds, best-effort revokes, nulls the token', async () => {
    const state = mintState('tesla');
    const created = await request(app).post('/api/session/create').send({ code: 'c', state });
    const res = await request(app).post('/api/session/destroy').set('Cookie', sessionValue(created));
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'][0]).toMatch(/^session=;/);
    const u = loadUsers()[0];
    expect(u.session_cookie_id).toBeNull();
    expect(u.refresh_token).toBeNull(); // orphaned → revoked locally too
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0].body).toContain('token=RT_live');
  });

  it('record with an active sub: unbinds the cookie but PRESERVES the token (cron needs it), no revoke', async () => {
    const state = mintState('tesla');
    const created = await request(app).post('/api/session/create').send({ code: 'c', state });
    patchUser(loadUsers()[0].id, { slack_user_id: 'U060NLFUM', vehicle_id: '1234567890123456' });
    const res = await request(app).post('/api/session/destroy').set('Cookie', sessionValue(created));
    expect(res.status).toBe(204);
    const u = loadUsers()[0];
    expect(u.session_cookie_id).toBeNull();
    expect(u.refresh_token).toBe('RT_live'); // preserved
    expect(revokeCalls).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../store/users.js', () => ({
  loadUserById: vi.fn(),
  patchUser: vi.fn(),
}));

const { loadUserById, patchUser } = await import('../store/users.js');
const {
  getTeslaAccess, RevokedError, ConfigError, TransientError, _resetInFlight,
} = await import('../integrations/tesla-auth.js');

const realFetch = globalThis.fetch;

function tokenResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
// A successful refresh response. Pass overrides to add/replace fields.
const okResponse = (over = {}) => tokenResponse({ body: { access_token: 'AT_NEW', expires_in: 28800, ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  _resetInFlight();
  globalThis.fetch = vi.fn();
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

const USER = (over = {}) => ({
  id: 'u1', refresh_token: 'RT0', access_token: null, access_expires_at: null,
  refresh_invalidated_at: null, ...over,
});

describe('getTeslaAccess — cache', () => {
  it('returns the cached access_token when it has >2min of life left', async () => {
    loadUserById.mockReturnValue(USER({
      access_token: 'AT_CACHED',
      access_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }));
    const tok = await getTeslaAccess('u1');
    expect(tok).toBe('AT_CACHED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(patchUser).not.toHaveBeenCalled();
  });

  it('refreshes when the cached token expires within the 2min margin', async () => {
    loadUserById.mockReturnValue(USER({
      access_token: 'AT_STALE',
      access_expires_at: new Date(Date.now() + 30 * 1000).toISOString(), // 30s left
    }));
    globalThis.fetch.mockResolvedValueOnce(okResponse({ refresh_token: 'RT1' }));
    const tok = await getTeslaAccess('u1');
    expect(tok).toBe('AT_NEW');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('getTeslaAccess — refresh + rotation', () => {
  it('persists the new access_token, expiry, and rotated refresh_token', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch.mockResolvedValueOnce(okResponse({ refresh_token: 'RT1' }));
    const tok = await getTeslaAccess('u1');
    expect(tok).toBe('AT_NEW');
    expect(patchUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      access_token: 'AT_NEW',
      refresh_token: 'RT1',
    }));
    const patch = patchUser.mock.calls[0][1];
    expect(typeof patch.access_expires_at).toBe('string');
  });

  it('does not write refresh_token to the patch when Tesla returns the same one', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch.mockResolvedValueOnce(okResponse({ refresh_token: 'RT0' }));
    await getTeslaAccess('u1');
    const patch = patchUser.mock.calls[0][1];
    expect('refresh_token' in patch).toBe(false);
  });

  it('sends client_secret on the refresh grant', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch.mockResolvedValueOnce(okResponse());
    await getTeslaAccess('u1');
    const body = globalThis.fetch.mock.calls[0][1].body;
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.has('client_secret')).toBe(true);
    expect(params.get('refresh_token')).toBe('RT0');
  });

  it('clears a stale refresh_invalidated_at on a successful refresh', async () => {
    // (Edge: a record that was marked invalid then got a fresh token via
    // re-OAuth. getTeslaAccess throws RevokedError before reaching this
    // in normal flow — but refreshOnce defensively clears it if it gets
    // there. Simulate by having loadUserById return a record WITHOUT the
    // invalidated flag on the first call (the cache check) and WITH it on
    // the re-load inside refreshOnce.)
    loadUserById
      .mockReturnValueOnce(USER())                                   // getTeslaAccess cache check
      .mockReturnValueOnce(USER({ refresh_invalidated_at: '2026-01-01T00:00:00Z' })); // refreshOnce re-load
    globalThis.fetch.mockResolvedValueOnce(okResponse());
    await getTeslaAccess('u1');
    expect(patchUser.mock.calls[0][1].refresh_invalidated_at).toBeNull();
  });
});

describe('getTeslaAccess — failure classification', () => {
  it('throws RevokedError + persists refresh_invalidated_at on invalid_grant', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch.mockResolvedValueOnce(tokenResponse({ status: 400, body: { error: 'invalid_grant' } }));
    await expect(getTeslaAccess('u1')).rejects.toBeInstanceOf(RevokedError);
    expect(patchUser).toHaveBeenCalledWith('u1', expect.objectContaining({ refresh_invalidated_at: expect.any(String) }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no retry on revoked
  });

  it('throws ConfigError WITHOUT invalidating on invalid_client', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch.mockResolvedValueOnce(tokenResponse({ status: 401, body: { error: 'invalid_client' } }));
    await expect(getTeslaAccess('u1')).rejects.toBeInstanceOf(ConfigError);
    expect(patchUser).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no retry on config error
  });

  it('throws an immediate RevokedError when the record is already invalidated (no fetch)', async () => {
    loadUserById.mockReturnValue(USER({ refresh_invalidated_at: '2026-01-01T00:00:00Z' }));
    await expect(getTeslaAccess('u1')).rejects.toBeInstanceOf(RevokedError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws when there is no user record', async () => {
    loadUserById.mockReturnValue(null);
    await expect(getTeslaAccess('nope')).rejects.toThrow(/no user record/);
  });
});

describe('getTeslaAccess — transient + retry', () => {
  it('retries up to 3 times on a 5xx, then propagates TransientError', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch
      .mockResolvedValueOnce(tokenResponse({ status: 503, body: {} }))
      .mockResolvedValueOnce(tokenResponse({ status: 502, body: {} }))
      .mockResolvedValueOnce(tokenResponse({ status: 500, body: {} }));
    await expect(getTeslaAccess('u1')).rejects.toBeInstanceOf(TransientError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on the 2nd attempt after one transient failure', async () => {
    loadUserById.mockReturnValue(USER());
    globalThis.fetch
      .mockResolvedValueOnce(tokenResponse({ status: 503, body: {} }))
      .mockResolvedValueOnce(okResponse());
    const tok = await getTeslaAccess('u1');
    expect(tok).toBe('AT_NEW');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a network throw (AbortSignal.timeout) as transient', async () => {
    loadUserById.mockReturnValue(USER());
    const abortErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    globalThis.fetch
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(okResponse());
    const tok = await getTeslaAccess('u1');
    expect(tok).toBe('AT_NEW');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('getTeslaAccess — single-flight', () => {
  it('two concurrent calls for the same user share one Tesla exchange', async () => {
    loadUserById.mockReturnValue(USER());
    let resolveFetch;
    globalThis.fetch.mockReturnValueOnce(new Promise(r => { resolveFetch = r; }));
    const p1 = getTeslaAccess('u1');
    const p2 = getTeslaAccess('u1');
    resolveFetch(okResponse());
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('AT_NEW');
    expect(t2).toBe('AT_NEW');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // one round-trip, not two
  });
});

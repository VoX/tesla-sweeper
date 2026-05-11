import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throwaway data dir BEFORE importing the store — its module body runs
// mkdirSync + the legacy-migration at import time, and we don't want
// `npm test` touching the real data/ dir on a fresh clone.
process.env.SWEEPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-store-test-'));

const { publicUser, publicSub } = await import('../store/users.js');

// The store module reads/writes a real path resolved at import time
// (`<repo>/data/users.json`) and runs a legacy-migration on first import.
// End-to-end disk behavior is exercised by the live deployment + the
// `/healthz` smoke test; these unit tests cover the pure helpers that
// don't require fs mocking.

describe('publicUser', () => {
  it('strips refresh_token, access_token, session_cookie_id, last_result, consecutive_failures, last_dm_*', () => {
    const full = {
      id: 'a', slack_user_id: 'U1', vehicle_name: 'Car', vehicle_id: '123',
      created_at: '2026-01-01', last_check_at: '2026-01-02',
      refresh_token: 'SECRET', access_token: 'ALSO_SECRET', session_cookie_id: 'sid',
      last_result: { error: 'oh no' }, consecutive_failures: 5,
      last_dm_date: '2026-01-02', last_dm_error_at: '2026-01-01',
      refresh_invalidated_at: null, access_expires_at: '2026-01-03',
    };
    const out = publicUser(full);
    expect(out).toEqual({
      id: 'a', slack_user_id: 'U1', vehicle_name: 'Car', vehicle_id: '123',
      created_at: '2026-01-01', last_check_at: '2026-01-02',
    });
    // Defensive: every sensitive field must be absent, not just undefined.
    for (const k of ['refresh_token', 'access_token', 'session_cookie_id',
                     'last_result', 'consecutive_failures', 'last_dm_date',
                     'last_dm_error_at', 'refresh_invalidated_at', 'access_expires_at']) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
  });

  it('does not crash on a record missing the optional fields', () => {
    const minimal = { id: 'b', slack_user_id: 'U2', vehicle_id: '1', vehicle_name: 'X', created_at: 't' };
    const out = publicUser(minimal);
    expect(out.id).toBe('b');
    expect(out.last_check_at).toBeUndefined();
  });

  it('publicSub is an alias for publicUser (legacy callers)', () => {
    expect(publicSub).toBe(publicUser);
  });
});

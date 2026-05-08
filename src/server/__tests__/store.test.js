import { describe, it, expect } from 'vitest';
import { publicSub } from '../store/subscriptions.js';

// The store module reads/writes a real path resolved at import time
// (`<repo>/data/subscriptions.json`). End-to-end disk behavior is
// covered by the live deployment + the `/healthz` smoke test in
// CI/manual checks; these unit tests cover the pure helpers that
// don't require fs mocking.

describe('publicSub', () => {
  it('strips refresh_token, last_result, consecutive_failures, last_dm_*', () => {
    const full = {
      id: 'a', slack_user_id: 'U1', vehicle_name: 'Car', vehicle_id: 123,
      created_at: '2026-01-01', last_check_at: '2026-01-02',
      refresh_token: 'SECRET', last_result: { error: 'oh no' },
      consecutive_failures: 5, last_dm_date: '2026-01-02', last_dm_error_at: '2026-01-01',
    };
    const out = publicSub(full);
    expect(out).toEqual({
      id: 'a', slack_user_id: 'U1', vehicle_name: 'Car', vehicle_id: 123,
      created_at: '2026-01-01', last_check_at: '2026-01-02',
    });
    // Defensive: every sensitive field must be absent, not just undefined.
    for (const k of ['refresh_token', 'last_result', 'consecutive_failures', 'last_dm_date', 'last_dm_error_at']) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
  });

  it('does not crash on a sub missing the optional fields', () => {
    const minimal = { id: 'b', slack_user_id: 'U2', vehicle_id: 1, vehicle_name: 'X', created_at: 't' };
    const out = publicSub(minimal);
    expect(out.id).toBe('b');
    expect(out.last_check_at).toBeUndefined();
  });
});

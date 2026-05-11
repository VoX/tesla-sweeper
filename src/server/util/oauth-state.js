// Server-side OAuth `state` registry — shared by /api/oauth/app/start +
// /api/slack/oauth/start (which mint) and the OAuth callbacks /
// /api/session/create (which consume). One-shot entries; a 10min TTL
// covers a sane redirect→exchange window; a hard cap keeps an
// unauthenticated /start flood from ballooning memory. See
// docs/bff-token-ownership-plan.md "Phase 5".

import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;
// 10k entries × ~80B ≈ 800K — fine at our scale (a single human user).
// Past the cap we GC and, if still full, refuse new mints (caller 503s).
const STATE_MAX_ENTRIES = 10_000;
const stateStore = new Map();

export function mintState(type) {
  // Lazy GC on each mint — bounds the map if a user starts flows but
  // never finishes. O(N), and N stays small.
  const now = Date.now();
  for (const [k, v] of stateStore) if (v.expires_at < now) stateStore.delete(k);
  if (stateStore.size >= STATE_MAX_ENTRIES) return null;
  const state = randomBytes(32).toString('base64url');
  stateStore.set(state, { type, expires_at: now + STATE_TTL_MS });
  return state;
}

export function consumeState(state, expectedType) {
  if (!state) return false;
  const entry = stateStore.get(state);
  if (!entry || entry.expires_at < Date.now() || entry.type !== expectedType) return false;
  stateStore.delete(state);
  return true;
}

// Test hook — drop all entries so cases don't leak state into each other.
export function _resetStateStore() { stateStore.clear(); }

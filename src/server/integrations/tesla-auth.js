// Server-side Tesla access-token broker — the single path both the SPA
// routes and the daily cron use to get a usable access_token for a user.
// Owns refresh-token rotation, response classification, and in-process
// single-flight so two callers for the same user share one Tesla
// round-trip instead of racing each other into a rotation collision.
//
// BFF migration (docs/bff-token-ownership-plan.md, Phase 2): replaces the
// inline teslaTokenExchange({grant_type:'refresh_token'}) calls scattered
// across the cron + /enable. Crucially it includes client_secret on the
// refresh grant — confidential clients require it; omitting it (as the
// old callers did) works only by accident on Tesla's first-party config.

import { loadUserById, patchUser } from '../store/users.js';
import { fetchWithTimeout } from '../util/fetch.js';

const TESLA_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';
// Refresh when the cached access_token has <2min of life left — covers
// clock skew + the refresh round-trip itself.
const ACCESS_TTL_MARGIN_MS = 2 * 60 * 1000;
// Tesla access_tokens are ~8h; default if expires_in is absent.
const DEFAULT_ACCESS_TTL_S = 8 * 60 * 60;
const MAX_REFRESH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;

// Failure-mode taxonomy. Each subclass is just an instanceof tag; the base
// fills in .name from the concrete class so callers/logs can switch on it.
class TaggedError extends Error { constructor(m) { super(m); this.name = this.constructor.name; } }
// refresh_token is dead (user revoked, password change, grant expired) —
// the user must re-OAuth. The record's refresh_invalidated_at is set.
export class RevokedError extends TaggedError {}
// Our OAuth client config is wrong (invalid_client / invalid_request) —
// the user's token is fine; don't touch it. Page someone.
export class ConfigError extends TaggedError {}
// Tesla 5xx / network blip — retried; propagated only after the retry
// budget is exhausted.
export class TransientError extends TaggedError {}

// Per-userId in-flight refresh promises so concurrent callers (the cron
// and a logged-in browser hitting an endpoint at the same moment)
// collapse to one Tesla exchange. In-process only — fine because the
// cron runs in the same node process; a future split-out cron worker
// would need file/db locking here.
const inFlight = new Map();

// Returns a usable access_token for the user, refreshing (and persisting
// the rotated refresh_token) if the cached one is missing/expiring.
// Throws RevokedError / ConfigError / TransientError per the failure mode.
export async function getTeslaAccess(userId) {
  const user = loadUserById(userId);
  if (!user) throw new Error(`getTeslaAccess: no user record for ${userId}`);
  if (user.refresh_invalidated_at) {
    throw new RevokedError(`refresh_token for ${userId} was invalidated at ${user.refresh_invalidated_at}`);
  }
  const expMs = user.access_expires_at ? Date.parse(user.access_expires_at) : 0;
  if (user.access_token && expMs - Date.now() > ACCESS_TTL_MARGIN_MS) {
    return user.access_token;
  }
  // Cache miss/stale → refresh. Single-flight by userId. (Everything
  // above this point is synchronous, so two concurrent callers can't
  // interleave before one of them registers the in-flight promise.)
  if (inFlight.has(userId)) return inFlight.get(userId);
  const p = refreshWithRetry(userId).finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

async function refreshWithRetry(userId) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      return await refreshOnce(userId);
    } catch (e) {
      if (e instanceof TransientError) {
        lastErr = e;
        if (attempt < MAX_REFRESH_ATTEMPTS) await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw e; // RevokedError / ConfigError / unexpected — don't retry
    }
  }
  // Budget exhausted — Tesla 5xx / network for all 3 attempts. The token
  // is untouched; the caller (cron stuck-DM, route 503) handles it.
  console.warn(`[session] refresh_failed userId=${userId} reason=transient (${MAX_REFRESH_ATTEMPTS} attempts): ${lastErr?.message}`);
  throw lastErr;
}

async function refreshOnce(userId) {
  // Re-load — defensive against the record changing between getTeslaAccess
  // and here (single-flight prevents two of *us*, but a /disable could
  // have run). A vanished record is, for the caller, the same outcome as
  // a revoked token: there's nothing to refresh, the user must re-OAuth.
  const user = loadUserById(userId);
  if (!user) throw new RevokedError(`user ${userId} vanished mid-refresh`);
  if (!user.refresh_token) throw new RevokedError(`user ${userId} has no refresh_token`);

  let res;
  try {
    res = await fetchWithTimeout(TESLA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET,
        refresh_token: user.refresh_token,
      }).toString(),
    });
  } catch (e) {
    throw new TransientError(`Tesla token endpoint unreachable: ${e.message}`);
  }

  if (res.status >= 500) throw new TransientError(`Tesla token endpoint ${res.status}`);

  let body;
  try { body = await res.json(); } catch { body = {}; }

  if (!res.ok) {
    if (body.error === 'invalid_grant') {
      patchUser(userId, { refresh_invalidated_at: new Date().toISOString() });
      console.warn(`[session] refresh_failed userId=${userId} reason=invalid_grant — refresh_token revoked, user must re-OAuth`);
      throw new RevokedError(`Tesla refused the refresh_token for ${userId}: invalid_grant`);
    }
    console.error(`[session] refresh_failed userId=${userId} reason=config status=${res.status} error=${body.error || '?'}`);
    throw new ConfigError(`Tesla token exchange config error (${res.status} ${body.error || ''})`);
  }

  if (!body.access_token) throw new TransientError('Tesla token response had no access_token');

  const expires_at = new Date(Date.now() + (body.expires_in || DEFAULT_ACCESS_TTL_S) * 1000).toISOString();
  const patch = { access_token: body.access_token, access_expires_at: expires_at };
  // Tesla rotates the refresh_token on every exchange — persist the new
  // one BEFORE returning so a crash downstream can't strand a now-dead
  // token. (Clearing any stale refresh_invalidated_at too, in case the
  // user re-OAuthed and a fresh token landed on the record.)
  if (body.refresh_token && body.refresh_token !== user.refresh_token) {
    patch.refresh_token = body.refresh_token;
  }
  if (user.refresh_invalidated_at) patch.refresh_invalidated_at = null;
  patchUser(userId, patch);
  return body.access_token;
}

// Test hook — clear the in-flight map so a test's mocked fetch isn't
// shared across cases. Not exported through the integrations barrel.
export function _resetInFlight() { inFlight.clear(); }

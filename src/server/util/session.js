// Session-cookie machinery for the BFF model. The cookie is a signed
// opaque id; the server maps the *unsigned* id to a user record's
// `session_cookie_id`. HttpOnly so JS can't read it; SameSite=Lax so the
// browser still sends it on the top-level OAuth return-redirect from
// auth.tesla.com but not on cross-site POSTs (the entire CSRF surface,
// now that we're on a dedicated origin). Host-only (no Domain), Path=/
// so it rides every sweeper.bitvox.me path including /api/*. No CSRF
// token needed — sibling apps on claw.bitvox.me aren't same-origin.

import { randomBytes } from 'node:crypto';
import { signOpaque, verifyOpaque } from '../crypto/session.js';

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Attribute rationale (HttpOnly/Secure/SameSite/host-only/Path) — see file header.
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'lax' };

// Mint a fresh session id. Returns { sid, signed } — store `sid` on the
// user record, hand `signed` to setSessionCookie.
export function mintSessionId() {
  const sid = randomBytes(32).toString('base64url');
  return { sid, signed: signOpaque(sid) };
}

// Extract + HMAC-verify the session cookie. Returns the unsigned sid, or
// null if absent/tampered. (req.cookies populated by cookie-parser.)
export function readSessionCookie(req) {
  const signed = req?.cookies?.[COOKIE_NAME];
  return signed ? verifyOpaque(signed) : null;
}

export function setSessionCookie(res, signed) {
  res.cookie(COOKIE_NAME, signed, { ...COOKIE_OPTS, maxAge: COOKIE_MAX_AGE_MS });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTS);
}

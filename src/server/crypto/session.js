import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

const HMAC_KEY = process.env.SESSION_HMAC_KEY || '';
if (!HMAC_KEY) {
  console.warn('[boot] SESSION_HMAC_KEY unset — all HMAC signing disabled: the slack→/enable gate and BFF session cookies will reject every request');
}

// Sign a "this requester just proved ownership of slack_user_id" claim.
// Format: "${slack_user_id}.${exp_ms}.${hmac_b64u}". Stateless; /enable +
// /disable verify it before persisting anything.
export function signSession(slackUserId) {
  if (!HMAC_KEY) return '';
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${slackUserId}.${exp}`;
  const mac = createHmac('sha256', HMAC_KEY).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifySession(token, slackUserId) {
  if (!HMAC_KEY || !token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [user, exp, mac] = parts;
  if (user !== slackUserId) return false;
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = createHmac('sha256', HMAC_KEY).update(`${user}.${exp}`).digest('base64url');
  const a = Buffer.from(mac, 'base64url'), b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Generic opaque-value signing — used for the long-lived session cookie.
// Format: "${value}.${hmac_b64u}". No expiry baked in; the cookie's
// Max-Age and the user record's last_seen_at prune handle lifetime. A
// tampered/forged cookie fails the HMAC check, so the server rejects it
// before any disk I/O.
export function signOpaque(value) {
  if (!HMAC_KEY) return '';
  const v = String(value);
  const mac = createHmac('sha256', HMAC_KEY).update(v).digest('base64url');
  return `${v}.${mac}`;
}

// Returns the original value if the signature checks out, else null.
export function verifyOpaque(signed) {
  if (!HMAC_KEY || !signed || typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = createHmac('sha256', HMAC_KEY).update(value).digest('base64url');
  const a = Buffer.from(mac, 'base64url'), b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? value : null;
}

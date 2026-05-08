import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

const HMAC_KEY = process.env.SESSION_HMAC_KEY || '';
if (!HMAC_KEY) {
  console.warn('[boot] SESSION_HMAC_KEY unset — slack→/enable session gate disabled, /enable will reject every request');
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

import { timingSafeEqual } from 'node:crypto';

// Constant-time check of `Authorization: Bearer <token>` against an
// expected token. timingSafeEqual throws on mismatched byte length, so
// gate on byte-length first (.length on a string is char count, not bytes).
export function bearerOk(authHeader, token) {
  if (!token) return false;
  const given = Buffer.from(authHeader);
  const expected = Buffer.from(`Bearer ${token}`);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

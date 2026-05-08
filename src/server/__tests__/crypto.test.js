import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

// HMAC-based session module reads SESSION_HMAC_KEY at import time. Set
// a deterministic key BEFORE the import so signSession/verifySession
// can sign + verify in this test process.
process.env.SESSION_HMAC_KEY = 'a'.repeat(64); // 32-byte hex
const { signSession, verifySession } = await import('../crypto/session.js');
const { bearerOk } = await import('../crypto/bearer.js');

describe('signSession / verifySession', () => {
  it('signs a token and verifies it for the same slack_user_id', () => {
    const token = signSession('U060NLFUM');
    expect(token).toMatch(/^U060NLFUM\.\d+\..+$/);
    expect(verifySession(token, 'U060NLFUM')).toBe(true);
  });

  it('rejects when slack_user_id mismatches', () => {
    const token = signSession('U060NLFUM');
    expect(verifySession(token, 'U999XXXXX')).toBe(false);
  });

  it('rejects a tampered MAC', () => {
    const token = signSession('U060NLFUM');
    const [user, exp, mac] = token.split('.');
    const tampered = `${user}.${exp}.${mac.slice(0, -2)}AA`;
    expect(verifySession(tampered, 'U060NLFUM')).toBe(false);
  });

  it('rejects a token with a non-numeric exp', () => {
    expect(verifySession('U.notanumber.AAA', 'U')).toBe(false);
  });

  it('rejects a token whose exp is in the past', () => {
    // Hand-build a token with exp=0 (1970), valid signature for that payload
    const payload = 'U060NLFUM.0';
    const mac = createHmac('sha256', 'a'.repeat(64)).update(payload).digest('base64url');
    expect(verifySession(`${payload}.${mac}`, 'U060NLFUM')).toBe(false);
  });

  it('rejects an empty/null/non-string token', () => {
    expect(verifySession('', 'U060NLFUM')).toBe(false);
    expect(verifySession(null, 'U060NLFUM')).toBe(false);
    expect(verifySession(123, 'U060NLFUM')).toBe(false);
  });

  it('rejects a token without 3 parts', () => {
    expect(verifySession('only.two', 'U')).toBe(false);
    expect(verifySession('a.b.c.d', 'U')).toBe(false);
  });
});

describe('bearerOk', () => {
  it('matches the expected token exactly', () => {
    expect(bearerOk('Bearer abc123', 'abc123')).toBe(true);
  });

  it('rejects a mismatched token', () => {
    expect(bearerOk('Bearer abc123', 'xyz789')).toBe(false);
  });

  it('rejects when the header is missing the Bearer prefix', () => {
    expect(bearerOk('abc123', 'abc123')).toBe(false);
  });

  it('rejects when token is empty/null', () => {
    expect(bearerOk('Bearer abc', '')).toBe(false);
    expect(bearerOk('Bearer abc', null)).toBe(false);
  });

  it('rejects when byte lengths differ (avoids timingSafeEqual throw)', () => {
    expect(bearerOk('Bearer short', 'much-longer-token')).toBe(false);
  });

  it('handles utf-8-byte-length quirk (multi-byte chars)', () => {
    // 'café' is 4 chars but 5 utf-8 bytes — the function must compare
    // byte-length, not char-length, before timingSafeEqual.
    expect(() => bearerOk('Bearer café', 'café')).not.toThrow();
    expect(bearerOk('Bearer café', 'café')).toBe(true);
  });
});

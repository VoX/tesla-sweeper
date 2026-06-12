import { describe, it, expect } from 'vitest';
import { rateLimit } from '../middleware/ratelimit.js';

// Drive the middleware directly with fake req/res — no app needed.
function hit(mw, { xff, remote = '127.0.0.1' } = {}) {
  const req = { headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } };
  let status = null;
  const res = { set: () => {}, status: (s) => { status = s; return res; }, json: () => res };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { nexted, status };
}

describe('rateLimit', () => {
  it('passes under the limit and 429s over it', () => {
    const mw = rateLimit({ perMinute: 3 });
    for (let i = 0; i < 3; i++) expect(hit(mw, { xff: '1.2.3.4' }).nexted).toBe(true);
    const over = hit(mw, { xff: '1.2.3.4' });
    expect(over.nexted).toBe(false);
    expect(over.status).toBe(429);
  });

  it('keys on the LAST X-Forwarded-For hop — a spoofed first segment cannot pick the bucket', () => {
    const mw = rateLimit({ perMinute: 2 });
    // Caddy appends the real client last: spoofed lists share the real
    // client's bucket no matter what the first segment claims.
    expect(hit(mw, { xff: 'fake-a, 9.9.9.9' }).nexted).toBe(true);
    expect(hit(mw, { xff: 'fake-b, 9.9.9.9' }).nexted).toBe(true);
    const third = hit(mw, { xff: 'fake-c, 9.9.9.9' });
    expect(third.nexted).toBe(false);
    expect(third.status).toBe(429);
  });

  it('separate middleware instances do not share buckets', () => {
    const a = rateLimit({ perMinute: 1 });
    const b = rateLimit({ perMinute: 1 });
    expect(hit(a, { xff: '5.5.5.5' }).nexted).toBe(true);
    expect(hit(a, { xff: '5.5.5.5' }).nexted).toBe(false);
    // Same IP, different route instance — fresh budget.
    expect(hit(b, { xff: '5.5.5.5' }).nexted).toBe(true);
  });

  it('falls back to the socket address when no XFF header is present', () => {
    const mw = rateLimit({ perMinute: 1 });
    expect(hit(mw, { remote: '10.0.0.1' }).nexted).toBe(true);
    expect(hit(mw, { remote: '10.0.0.1' }).nexted).toBe(false);
    expect(hit(mw, { remote: '10.0.0.2' }).nexted).toBe(true);
  });
});

// Tiny per-IP token bucket for the public, upstream-expensive probe routes.
// No external deps: capacity tokens per window, refilled continuously. The
// bucket map is pruned on each call so an address scan can't grow it forever.

const BUCKETS = new Map();
const MAX_BUCKETS = 10_000;

export function rateLimit({ perMinute = 10 } = {}) {
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  return (req, res, next) => {
    // Caddy fronts us on loopback — the client is in X-Forwarded-For.
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
      .split(',')[0].trim();
    const now = Date.now();
    let b = BUCKETS.get(ip);
    if (!b) {
      if (BUCKETS.size >= MAX_BUCKETS) BUCKETS.clear(); // crude flood reset
      b = { tokens: capacity, at: now };
      BUCKETS.set(ip, b);
    }
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refillPerMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set('Retry-After', '30');
      return res.status(429).json({ detail: 'Rate limit exceeded' });
    }
    b.tokens -= 1;
    next();
  };
}

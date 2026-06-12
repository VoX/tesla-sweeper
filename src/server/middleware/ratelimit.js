// Tiny per-IP token bucket for the public, upstream-expensive probe routes.
// No external deps: capacity tokens per window, refilled continuously. The
// bucket map is pruned on each call so an address scan can't grow it forever.

const MAX_BUCKETS = 10_000;

export function rateLimit({ perMinute = 10 } = {}) {
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  // Per-instance bucket map: each rate-limited route gets its own budget.
  // A shared module-level map let traffic on one route drain another's
  // tokens (and mixed per-route capacities corrupted the shared bucket).
  const buckets = new Map();
  return (req, res, next) => {
    // Caddy fronts us on loopback and APPENDS the real client address to
    // any inbound X-Forwarded-For — so the LAST hop is the only segment
    // the client can't spoof. (Taking the first segment let a client pick
    // its own bucket with a forged header.)
    const xff = req.headers['x-forwarded-for'];
    const ip = xff
      ? xff.split(',').at(-1).trim()
      : (req.socket.remoteAddress || '?');
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
      if (buckets.size >= MAX_BUCKETS) buckets.clear(); // crude flood reset
      b = { tokens: capacity, at: now };
      buckets.set(ip, b);
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

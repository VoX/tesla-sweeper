// Public probe endpoints + healthz (side-detection, sweep-check, liveness).

import { Router } from 'express';
import { wrap } from '../middleware/errors.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { whichSide } from '../integrations/overpass.js';
import { runSweepCheck } from '../sweep/check.js';
import { loadStore } from '../store/users.js';

export const probesRouter = Router();

probesRouter.post('/api/which-side', rateLimit({ perMinute: 12 }), wrap(async (req, res) => {
  const { lat, lng } = req.body;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ detail: 'lat and lng required as finite numbers in valid range' });
  }
  res.json(await whichSide(lat, lng));
}));

probesRouter.post('/api/sweep-check', rateLimit({ perMinute: 12 }), wrap(async (req, res) => {
  const { address, today_date, past_noon, lat, lng, city } = req.body;
  if (!address) return res.status(400).json({ detail: 'Address required' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ detail: 'lat and lng required as finite numbers in valid range' });
  }
  res.json(await runSweepCheck({ address, today_date, past_noon, lat, lng, city }));
}));

// Liveness/ops probe — `last_run_at` answers "is the cron working" in
// one curl. Cheap, no auth, no PII.
probesRouter.get('/healthz', (req, res) => {
  const store = loadStore();
  res.json({
    ok: true,
    last_run_at: store.last_run_at || null,
    last_digest_run_at: store.last_digest_run_at || null,
    // DM-delivery health, distinct from check health: a rotated shared Slack
    // token kills DMs while checks stay green (it has happened).
    last_dm_success_at: store.last_dm_success_at || null,
    last_dm_error: store.last_dm_error || null,
    sub_count: store.users.filter(u => u.slack_user_id && u.vehicle_id).length,
  });
});

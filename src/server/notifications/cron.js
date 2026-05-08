// Daily + weekly notification cron + runNotifications driver.
// Per-sub: token refresh → wake/locate → geocode → sweep check →
// plan → Slack DM. Single-flight by mode (same-mode reuses the
// promise; cross-mode throws).

import cron from 'node-cron';
import { classifyWeek, shouldDispatchPlan, formatPlanDM, formatWeeklyDigest } from './planner.js';
import { loadStore, saveStore, patchSub } from '../store/subscriptions.js';
import {
  STUB_VEHICLE_ENABLED, STUB_REFRESH_TOKEN, STUB_VEHICLE_LAT, STUB_VEHICLE_LNG,
  teslaTokenExchange, fetchVehicleData,
} from '../integrations/tesla.js';
import { reverseGeocodeLocation } from '../integrations/nominatim.js';
import { postSlackDM } from '../integrations/slack.js';
import { runSweepCheck } from '../sweep/check.js';

const TESLA_APP_CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const STUCK_FAIL_THRESHOLD = 3;
const STUCK_DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let runningNotifications = null;
let runningMode = null;

export async function runNotifications({ mode = 'daily' } = {}) {
  if (mode !== 'daily' && mode !== 'weekly') {
    throw new Error(`runNotifications: invalid mode '${mode}'`);
  }
  if (runningNotifications) {
    if (runningMode === mode) return runningNotifications;
    throw new Error(`runNotifications: another run already in flight (mode='${runningMode}')`);
  }
  runningMode = mode;
  runningNotifications = (async () => {
    const subs = loadStore().subscriptions || [];
    const results = [];
    const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

    for (const sub of subs) {
      const out = { sub_id: sub.id, slack_user_id: sub.slack_user_id, vehicle_id: sub.vehicle_id, vehicle_name: sub.vehicle_name };
      try {
        let latitude, longitude;
        if (STUB_VEHICLE_ENABLED && sub.refresh_token === STUB_REFRESH_TOKEN) {
          // Stub: skip Tesla token refresh + vehicle_data wake-and-poll.
          // Reverse-geocode + Recollect + Slack DM still run for real.
          latitude = STUB_VEHICLE_LAT;
          longitude = STUB_VEHICLE_LNG;
          out.battery_level = 78;
        } else {
          const rotated = await teslaTokenExchange({ grant_type: 'refresh_token', client_id: TESLA_APP_CLIENT_ID, refresh_token: sub.refresh_token });
          // Tesla rotates refresh_tokens on each exchange; persist
          // immediately so a crash later in the loop doesn't leave us
          // with a now-revoked token next run.
          if (rotated.refresh_token && rotated.refresh_token !== sub.refresh_token) {
            patchSub(sub.id, { refresh_token: rotated.refresh_token });
          }
          const headers = { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' };

          const locData = await fetchVehicleData(headers, sub.vehicle_id);
          ({ latitude, longitude } = locData.response?.drive_state || {});
          out.battery_level = locData.response?.charge_state?.battery_level ?? null;
        }
        if (latitude == null || longitude == null) throw new Error('No vehicle location');

        const geo = await reverseGeocodeLocation(latitude, longitude);
        const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
        out.address = geo.display_name || addr;
        if (!addr) throw new Error('No street resolved from coordinates');

        const sweep = await runSweepCheck({ address: addr, today_date: todayET, lat: latitude, lng: longitude });
        out.found = !!sweep.found;
        out.days_until_next = sweep.days_until_next ?? null;
        out.status = sweep.status || null;
        out.title = sweep.title || null;
        out.message = sweep.message || null;
        out.car_side = sweep.car_side || null;
        out.sweep_events = sweep.sweep_events || [];
        out.side_detection = sweep.side_detection || null;
        // Canonicalize on the OSM-detected car-side house number — the
        // reverse-geocode often returns the closest building (which can
        // be on the opposite curb, especially for oversized lots) and
        // we don't want the DM to name a house that isn't the user's.
        // `!= null && !== ''` instead of truthy — house number 0 is rare
        // but real (some commercial lots), and OSM data does include it.
        const carHouseNum = sweep.side_detection?.car_house_number;
        if (carHouseNum != null && carHouseNum !== '' && geo.street) {
          out.address = geo.city ? `${carHouseNum} ${geo.street}, ${geo.city}` : `${carHouseNum} ${geo.street}`;
        }
        out.ok = true;
      } catch (e) {
        out.ok = false;
        out.error = e.message;
      }
      // Track consecutive_failures so we can DM the user once their
      // sub stops working (Tesla token revoked, vehicle removed, etc).
      out.consecutive_failures = out.ok ? 0 : (sub.consecutive_failures || 0) + 1;
      patchSub(sub.id, {
        last_check_at: new Date().toISOString(),
        last_result: { ok: out.ok, days_until_next: out.days_until_next, error: out.error },
        consecutive_failures: out.consecutive_failures,
      });
      out.last_dm_error_at = sub.last_dm_error_at || null;
      out.last_dm_date = sub.last_dm_date || null;
      out.last_digest_date = sub.last_digest_date || null;
      out.plan = (out.ok && out.found) ? classifyWeek({
        events: out.sweep_events || [], carSide: out.car_side,
        sideDetection: out.side_detection, todayET,
      }) : null;
      results.push(out);
    }

    if (mode === 'daily') {
      // Per-sub plan classifier picks one of N action classes; only fire
      // when class != safe AND the soonest event is 1-3 days out.
      // last_dm_date dedupes across same-day re-runs.
      for (const out of results) {
        if (!out.plan || !shouldDispatchPlan(out.plan)) continue;
        if (out.last_dm_date === todayET) { out.dm_skipped = 'already-sent-today'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatPlanDM({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan }));
        out.dm_sent = dm.ok;
        out.dm_error = dm.error || null;
        if (dm.ok) patchSub(out.sub_id, { last_dm_date: todayET });
      }
    } else if (mode === 'weekly') {
      // Sunday-evening digest: full schedule + recommendation, every sub
      // regardless of imminence. Separate dedup field so daily and weekly
      // cadences don't suppress each other when both fire the same Sunday.
      for (const out of results) {
        if (!out.plan) continue;
        if (out.last_digest_date === todayET) { out.digest_skipped = 'already-sent-today'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatWeeklyDigest({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan }));
        out.digest_sent = dm.ok;
        out.digest_error = dm.error || null;
        if (dm.ok) patchSub(out.sub_id, { last_digest_date: todayET });
      }
    }

    // Stuck-sub notice: DM once the failure count crosses the threshold,
    // then once per day while it stays stuck. Daily-mode only so a Sunday
    // 8PM digest doesn't double-DM a sub whose token is dead.
    if (mode === 'daily') {
      for (const out of results) {
        if (out.ok || out.consecutive_failures < STUCK_FAIL_THRESHOLD) continue;
        const lastErrTs = out.last_dm_error_at ? Date.parse(out.last_dm_error_at) : 0;
        if (Date.now() - lastErrTs < STUCK_DM_COOLDOWN_MS) continue;
        const dm = await postSlackDM(out.slack_user_id,
          `:warning: *${out.vehicle_name}* sweeper notifications have been failing for ${out.consecutive_failures} runs. Last error: \`${out.error}\`. Re-enable at <https://claw.bitvox.me/sweeper/>.`);
        out.error_dm_sent = dm.ok;
        if (dm.ok) patchSub(out.sub_id, { last_dm_error_at: new Date().toISOString() });
      }
    }

    // Only mark "ran today" if at least one sub processed successfully.
    // A total-outage day shouldn't suppress tomorrow's missed-run recovery.
    if (results.some(r => r.ok)) {
      const store = loadStore();
      if (mode === 'daily') store.last_run_at = new Date().toISOString();
      else store.last_digest_run_at = new Date().toISOString();
      saveStore(store);
    }
    return { ran_at: new Date().toISOString(), mode, results };
  })().finally(() => { runningNotifications = null; runningMode = null; });
  return runningNotifications;
}

// Daily noon-ET notification cron + Sunday-evening digest. node-cron
// handles DST via the timezone string, so the calendar expressions
// stay identical year-round.
export function startNotificationCron() {
  cron.schedule('0 12 * * *', async () => {
    console.log('[cron] firing daily notification run');
    try {
      const r = await runNotifications({ mode: 'daily' });
      const errs = r.results.filter(o => !o.ok);
      const dmFails = r.results.filter(o => o.dm_sent === false && o.plan && shouldDispatchPlan(o.plan));
      const dmsOk = r.results.filter(o => o.dm_sent).length;
      const dmsDup = r.results.filter(o => o.dm_skipped).length;
      const dmsStuck = r.results.filter(o => o.error_dm_sent).length;
      console.log(`[cron] subs=${r.results.length} dm_sent=${dmsOk} dm_dup=${dmsDup} dm_stuck=${dmsStuck} errs=${errs.length} dm_fails=${dmFails.length}`);
      for (const o of errs) console.warn(`[cron] sub ${o.sub_id} (${o.vehicle_name}) error: ${o.error} (fails=${o.consecutive_failures})`);
      for (const o of dmFails) console.warn(`[cron] sub ${o.sub_id} (${o.vehicle_name}) DM failed: ${o.dm_error}`);
    } catch (e) { console.error('[cron] runNotifications failed:', e); }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 20 * * 0', async () => {
    console.log('[cron] firing weekly digest run');
    try {
      const r = await runNotifications({ mode: 'weekly' });
      const errs = r.results.filter(o => !o.ok);
      const sent = r.results.filter(o => o.digest_sent).length;
      const dup = r.results.filter(o => o.digest_skipped).length;
      console.log(`[cron] digest subs=${r.results.length} sent=${sent} dup=${dup} errs=${errs.length}`);
      for (const o of errs) console.warn(`[cron] digest sub ${o.sub_id} error: ${o.error}`);
    } catch (e) { console.error('[cron] weekly digest failed:', e); }
  }, { timezone: 'America/New_York' });
}

// On boot, recover a missed run. If we're already past noon ET today
// and the last successful run was on a prior date (in ET), fire once.
// Avoids the failure mode where the service restarts between 12:00pm
// and tomorrow's cron, silently skipping today.
// Returns the runNotifications promise (or null when no recovery
// needed) so the caller can await — chaining run+digest sequentially
// matters because runNotifications throws on cross-mode overlap.
export function maybeRecoverMissedRun() {
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const todayET = fmtDate.format(new Date());
  const hourET = parseInt(fmtHour.format(new Date()), 10);
  if (hourET < 12) return null;
  const last = loadStore().last_run_at || null;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return null;
  console.log(`[cron] recovering missed run (last: ${lastDateET || 'never'}, today: ${todayET})`);
  return runNotifications();
}

// Symmetric digest recovery: if today is Sunday past 8PM ET and we
// haven't run a digest in this calendar week, fire one. Otherwise a
// boot across Sunday 8PM silently skips that week's digest forever.
export function maybeRecoverMissedDigest() {
  const now = new Date();
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmtParts.formatToParts(now).map(p => [p.type, p.value]));
  if (parts.weekday !== 'Sun' || parseInt(parts.hour, 10) < 20) return null;
  const todayET = fmtDate.format(now);
  const last = loadStore().last_digest_run_at || null;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return null;
  console.log(`[cron] recovering missed digest (last: ${lastDateET || 'never'}, today: ${todayET})`);
  return runNotifications({ mode: 'weekly' });
}

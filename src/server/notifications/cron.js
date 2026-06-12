// Notification crons + runNotifications driver.
// Per-sub: token refresh → wake/locate → geocode → sweep check →
// plan → Slack DM. Single-flight by mode (same-mode reuses the
// promise; cross-mode throws).
//
// Run schedule (all America/New_York; node-cron handles DST):
//   12:00 daily  — 'daily':   plan dispatch (days 3 + 1) + stuck-sub DMs
//   21:00 daily  — 'evening': same dispatch, cars are home by now; the
//                  plan-aware dedup key means it only DMs when the noon
//                  run missed (car was out at noon) or the plan CHANGED
//   07:00 daily  — 'dayof':   last-call check, ONLY for subs whose
//                  persisted next_event_date is today (zero wakes on
//                  non-event days); DMs only if the car is still on the
//                  swept side (status 'danger')
//   Sun 20:00    — 'weekly':  digest
// Jan–Mar is off-season (no Somerville sweeping): every mode skips
// before touching the car, except the one season-preview digest in the
// last week of March.

import cron from 'node-cron';
import {
  classifyWeek, shouldDispatchPlan, formatPlanDM, formatWeeklyDigest,
  formatDayOfDM, formatSeasonPreviewDM, isOffSeason, isSeasonPreviewWindow,
} from './planner.js';
import { loadStore, saveStore, patchUser, loadSubscribedUsers, pruneOrphaned } from '../store/users.js';
import {
  STUB_VEHICLE_LAT, STUB_VEHICLE_LNG,
  isStubVehicle, fetchVehicleData,
} from '../integrations/tesla.js';
import { getTeslaAccess } from '../integrations/tesla-auth.js';
import { reverseGeocodeLocation } from '../integrations/nominatim.js';
import { postSlackDM, escapeSlack } from '../integrations/slack.js';
import { runSweepCheck } from '../sweep/check.js';

const STUCK_FAIL_THRESHOLD = 3;
const STUCK_DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Error classes where re-doing OAuth actually helps — the only ones worth
// DMing the USER about. Everything else (Tesla 5xx, OSM down, Recollect
// drift) goes to the operator instead: wrong audience, wrong remedy.
const REAUTH_ERROR_CLASSES = ['RevokedError', 'ConfigError'];
const OPERATOR_SLACK_ID = process.env.OPERATOR_SLACK_ID || '';

const MODES = ['daily', 'evening', 'dayof', 'weekly'];
const PLAN_DISPATCH_MODES = ['daily', 'evening'];

export const todayInET = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

// Plan-aware DM dedup key: same date + same plan shape = already told the
// user. A changed class or primary event (car moved, schedule shifted)
// produces a new key, so the evening run re-DMs exactly when the advice
// changed and stays silent when it didn't.
export const planDmKey = (todayET, plan) =>
  `${todayET}|${plan.class}|${plan.primaryEvent?.date || ''}`;

// One sub's locate → geocode → sweep-check → classify pipeline. Pure
// read path — NO store writes (the cron loop owns persistence; the
// /sweep slash command calls this directly and must not touch streaks).
export async function checkSubNow(sub, todayET) {
  const out = { sub_id: sub.id, slack_user_id: sub.slack_user_id, vehicle_id: sub.vehicle_id, vehicle_name: sub.vehicle_name };
  try {
    let latitude, longitude;
    if (isStubVehicle(sub.vehicle_id)) {
      // Stub: skip Tesla token refresh + vehicle_data wake-and-poll.
      // Reverse-geocode + Recollect + Slack DM still run for real.
      latitude = STUB_VEHICLE_LAT;
      longitude = STUB_VEHICLE_LNG;
      out.battery_level = 78;
    } else {
      // getTeslaAccess owns refresh-token rotation + persistence and
      // throws RevokedError / ConfigError / TransientError.
      const access = await getTeslaAccess(sub.id);
      const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };
      const locData = await fetchVehicleData(headers, sub.vehicle_id);
      ({ latitude, longitude } = locData.response?.drive_state || {});
      out.battery_level = locData.response?.charge_state?.battery_level ?? null;
    }
    if (latitude == null || longitude == null) throw new Error('No vehicle location');

    const geo = await reverseGeocodeLocation(latitude, longitude);
    const addr = [geo.house_number, geo.street].filter(Boolean).join(' ');
    out.address = geo.display_name || addr;
    if (!addr) throw new Error('No street resolved from coordinates');

    const sweep = await runSweepCheck({ address: addr, today_date: todayET, lat: latitude, lng: longitude, city: geo.city });
    out.found = !!sweep.found;
    out.days_until_next = sweep.days_until_next ?? null;
    out.status = sweep.status || null;
    out.title = sweep.title || null;
    out.message = sweep.message || null;
    out.car_side = sweep.car_side || null;
    out.sweep_events = sweep.sweep_events || [];
    out.side_detection = sweep.side_detection || null;
    out.nearest_note = sweep.nearest_note || null;
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
    // Taxonomy tag (RevokedError/ConfigError/TransientError) or plain
    // 'Error' — drives who gets the stuck-sub DM.
    out.error_class = e.name || 'Error';
  }
  out.plan = (out.ok && out.found) ? classifyWeek({
    events: out.sweep_events, carSide: out.car_side,
    sideDetection: out.side_detection, todayET,
  }) : null;
  return out;
}

let runningNotifications = null;
let runningMode = null;

// `todayET` is injectable for tests only (the season gate + dispatch
// windows are date-dependent; a real-clock suite breaks every winter).
// The cron entries never pass it.
export async function runNotifications({ mode = 'daily', todayET: todayOverride } = {}) {
  if (!MODES.includes(mode)) {
    throw new Error(`runNotifications: invalid mode '${mode}'`);
  }
  if (runningNotifications) {
    if (runningMode === mode) return runningNotifications;
    throw new Error(`runNotifications: another run already in flight (mode='${runningMode}')`);
  }
  runningMode = mode;
  runningNotifications = (async () => {
    const todayET = todayOverride || todayInET();

    // Season gate: Jan–Mar there is no Somerville sweeping. Never wake
    // the car for nothing. One exception: the last-week-of-March Sunday
    // digest becomes a "season starts Apr 1" preview.
    if (isOffSeason(todayET)) {
      if (mode === 'weekly' && isSeasonPreviewWindow(todayET)) {
        const results = [];
        for (const sub of loadSubscribedUsers()) {
          if (sub.last_digest_date === todayET) continue;
          const dm = await postSlackDM(sub.slack_user_id, formatSeasonPreviewDM({ vehicleName: sub.vehicle_name }));
          if (dm.ok) patchUser(sub.id, { last_digest_date: todayET });
          results.push({ sub_id: sub.id, digest_sent: dm.ok, digest_error: dm.error || null });
        }
        // Same store bookkeeping as a real run: advance last_digest_run_at
        // (else maybeRecoverMissedDigest re-fires all preview-Sunday evening)
        // and record DM health (a token-dead preview night must surface in
        // /healthz, not vanish — the May-2026 silent mode).
        if (results.length) {
          const store = loadStore();
          store.last_digest_run_at = new Date().toISOString();
          if (results.some(r => r.digest_sent)) {
            store.last_dm_success_at = new Date().toISOString();
            store.last_dm_error = null;
          } else {
            store.last_dm_error = `${new Date().toISOString()}: ${results.find(r => r.digest_error)?.digest_error || 'unknown'}`;
          }
          saveStore(store);
        }
        return { ran_at: new Date().toISOString(), mode, off_season: true, season_preview: true, results };
      }
      console.log(`[cron] off-season (${todayET}) — skipping ${mode} run`);
      return { ran_at: new Date().toISOString(), mode, off_season: true, results: [] };
    }

    // Day-of runs only ever touch subs with an event TODAY (persisted by
    // the previous runs' plans) — that's what keeps 7am wakes rare.
    let subs = loadSubscribedUsers();
    if (mode === 'dayof') {
      subs = subs.filter(s => s.next_event_date === todayET);
      if (!subs.length) {
        return { ran_at: new Date().toISOString(), mode, results: [] };
      }
    }

    const results = [];
    for (const sub of subs) {
      const out = await checkSubNow(sub, todayET);
      // Track consecutive_failures so we can DM once a sub stops working
      // (Tesla token revoked, vehicle removed, etc).
      out.consecutive_failures = out.ok ? 0 : (sub.consecutive_failures || 0) + 1;
      const persist = {
        last_check_at: new Date().toISOString(),
        last_result: { ok: out.ok, days_until_next: out.days_until_next, error: out.error, error_class: out.error_class },
        consecutive_failures: out.consecutive_failures,
      };
      // Persist the next user-side event date so the 7am day-of run can
      // gate on it without locating anything. Clear it when the plan says
      // safe; leave it untouched on failures / car-out-of-town days (a
      // stale date costs one extra 7am locate, never a missed one).
      if (out.plan) {
        persist.next_event_date = out.plan.class === 'safe' ? null : (out.plan.primaryEvent?.date || null);
      }
      // Recovery: clear the stuck-DM cooldown timestamp so a future
      // outage can DM immediately instead of waiting up to 24h on a
      // stale `last_dm_error_at` from the prior failure window.
      if (out.ok && sub.last_dm_error_at) persist.last_dm_error_at = null;
      patchUser(sub.id, persist);
      out.last_dm_error_at = sub.last_dm_error_at || null;
      out.last_dm_key = sub.last_dm_key || null;
      out.last_dm_date = sub.last_dm_date || null;
      out.last_dayof_date = sub.last_dayof_date || null;
      out.last_digest_date = sub.last_digest_date || null;
      results.push(out);
    }

    if (PLAN_DISPATCH_MODES.includes(mode)) {
      // Per-sub plan classifier picks one of N action classes; only fire
      // at 3 days out (heads-up) and 1 day out (last call). The dedup key
      // is plan-aware: a same-day re-run (the evening pass) only re-DMs
      // when the plan actually changed.
      for (const out of results) {
        if (!out.plan || !shouldDispatchPlan(out.plan)) continue;
        const key = planDmKey(todayET, out.plan);
        // Transition fallback: records from before last_dm_key existed
        // dedupe on the old date-only field for one day.
        const dup = out.last_dm_key
          ? out.last_dm_key === key
          : out.last_dm_date === todayET;
        if (dup) { out.dm_skipped = 'already-sent'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatPlanDM({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan, nearestNote: out.nearest_note }));
        out.dm_sent = dm.ok;
        out.dm_error = dm.error || null;
        if (dm.ok) patchUser(out.sub_id, { last_dm_date: todayET, last_dm_key: key });
      }
    } else if (mode === 'dayof') {
      // 7am last call: only when the car is STILL on the swept side
      // (check.js status 'danger' = sweeping today, car side matches,
      // before noon). Once per day per sub.
      for (const out of results) {
        if (!out.ok || out.status !== 'danger') continue;
        if (out.last_dayof_date === todayET) { out.dm_skipped = 'already-sent'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatDayOfDM({ vehicleName: out.vehicle_name, address: out.address, message: out.message, nearestNote: out.nearest_note }));
        out.dm_sent = dm.ok;
        out.dm_error = dm.error || null;
        if (dm.ok) patchUser(out.sub_id, { last_dayof_date: todayET });
      }
    } else if (mode === 'weekly') {
      // Sunday-evening digest: full schedule + recommendation, every sub
      // regardless of imminence. Separate dedup field so daily and weekly
      // cadences don't suppress each other when both fire the same Sunday.
      for (const out of results) {
        if (!out.plan) continue;
        if (out.last_digest_date === todayET) { out.digest_skipped = 'already-sent-today'; continue; }
        const dm = await postSlackDM(out.slack_user_id,
          formatWeeklyDigest({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan, nearestNote: out.nearest_note }));
        out.digest_sent = dm.ok;
        out.digest_error = dm.error || null;
        if (dm.ok) patchUser(out.sub_id, { last_digest_date: todayET });
      }
    }

    // Stuck-sub notice once the failure count crosses the threshold, then
    // once per day while it stays stuck. Noon-mode only so the evening
    // pass and Sunday digest don't double-DM a dead sub. Routing is
    // class-aware: the USER only hears about it when re-auth would fix it;
    // transient infrastructure streaks go to the operator instead.
    if (mode === 'daily') {
      for (const out of results) {
        if (out.ok || out.consecutive_failures < STUCK_FAIL_THRESHOLD) continue;
        const lastErrTs = out.last_dm_error_at ? Date.parse(out.last_dm_error_at) : 0;
        if (Date.now() - lastErrTs < STUCK_DM_COOLDOWN_MS) continue;
        let dm;
        if (REAUTH_ERROR_CLASSES.includes(out.error_class)) {
          dm = await postSlackDM(out.slack_user_id,
            `:warning: *${escapeSlack(out.vehicle_name)}* sweeper notifications have been failing for ${out.consecutive_failures} runs (${out.error_class === 'RevokedError' ? 'Tesla authorization expired or revoked' : 'app configuration problem'}). Re-enable at <https://sweeper.bitvox.me/>.`);
        } else if (OPERATOR_SLACK_ID) {
          // Not a re-auth class — could be transient infra OR a permanent
          // vehicle-level failure (sold car → vehicle_data 404). The
          // operator triages; escalate to the user manually if persistent.
          dm = await postSlackDM(OPERATOR_SLACK_ID,
            `:wrench: sweeper sub *${escapeSlack(out.vehicle_name)}* (${out.slack_user_id}) failing for ${out.consecutive_failures} runs on ${out.error_class || 'Error'}: \`${escapeSlack(out.error)}\`. Non-reauth class — user not auto-notified; escalate if persistent.`);
        } else {
          // No operator configured: fall back to the old behavior (tell
          // the user something is wrong) rather than telling NOBODY.
          dm = await postSlackDM(out.slack_user_id,
            `:warning: *${escapeSlack(out.vehicle_name)}* sweeper notifications have been failing for ${out.consecutive_failures} runs. Last error: \`${escapeSlack(out.error)}\`. If this persists, re-enable at <https://sweeper.bitvox.me/>.`);
        }
        out.error_dm_sent = dm.ok;
        if (dm.ok) patchUser(out.sub_id, { last_dm_error_at: new Date().toISOString() });
      }
    }

    // Only mark "ran today" if at least one sub processed successfully.
    // A total-outage day shouldn't suppress tomorrow's missed-run recovery.
    // DM-delivery health is tracked SEPARATELY: the checks can keep succeeding
    // (last_run_at fresh) while every DM dies on a rotated shared Slack token —
    // the May 2026 silent-breakage mode. /healthz exposes these fields so
    // outside monitoring can alert on DM staleness specifically.
    const dmAttempts = results.filter(r => r.dm_sent !== undefined || r.error_dm_sent !== undefined);
    const dmOk = results.some(r => r.dm_sent || r.error_dm_sent);
    const firstDmErr = results.find(r => r.dm_error)?.dm_error || null;
    if (results.some(r => r.ok) || dmAttempts.length) {
      const store = loadStore();
      if (results.some(r => r.ok)) {
        // last_run_at means "the full-roster plan run happened today" —
        // maybeRecoverMissedRun keys on it, so the 7am dayof pass (pre-noon,
        // filtered roster) must NOT bump it or it suppresses noon recovery
        // on exactly the days that matter. dayof gets its own stamp for its
        // own recovery helper.
        if (mode === 'weekly') store.last_digest_run_at = new Date().toISOString();
        else if (mode === 'dayof') store.last_dayof_run_at = new Date().toISOString();
        else store.last_run_at = new Date().toISOString();
      }
      if (dmOk) {
        store.last_dm_success_at = new Date().toISOString();
        store.last_dm_error = null;
      } else if (dmAttempts.length) {
        store.last_dm_error = `${new Date().toISOString()}: ${firstDmErr || 'unknown'}`;
      }
      saveStore(store);
    }
    return { ran_at: new Date().toISOString(), mode, results };
  })().finally(() => { runningNotifications = null; runningMode = null; });
  return runningNotifications;
}

function logRun(label, r) {
  const errs = r.results.filter(o => o.ok === false);
  const sent = r.results.filter(o => o.dm_sent || o.digest_sent).length;
  const dup = r.results.filter(o => o.dm_skipped || o.digest_skipped).length;
  const dmFails = r.results.filter(o => o.dm_sent === false || o.digest_sent === false);
  const stuck = r.results.filter(o => o.error_dm_sent).length;
  console.log(`[cron] ${label} subs=${r.results.length} sent=${sent} dup=${dup} stuck_dm=${stuck} errs=${errs.length} dm_fails=${dmFails.length}${r.off_season ? ' (off-season)' : ''}`);
  for (const o of errs) console.warn(`[cron] ${label} sub ${o.sub_id} (${o.vehicle_name}) error [${o.error_class}]: ${o.error} (fails=${o.consecutive_failures})`);
  for (const o of dmFails) console.warn(`[cron] ${label} sub ${o.sub_id} (${o.vehicle_name}) DM failed: ${o.dm_error || o.digest_error}`);
}

// node-cron handles DST via the timezone string, so the calendar
// expressions stay identical year-round.
export function startNotificationCron() {
  const fire = (label, mode) => async () => {
    console.log(`[cron] firing ${label} run`);
    try { logRun(label, await runNotifications({ mode })); }
    catch (e) { console.error(`[cron] ${label} run failed:`, e); }
  };
  cron.schedule('0 12 * * *', fire('daily', 'daily'), { timezone: 'America/New_York' });
  cron.schedule('0 21 * * *', fire('evening', 'evening'), { timezone: 'America/New_York' });
  cron.schedule('0 7 * * *', fire('dayof', 'dayof'), { timezone: 'America/New_York' });
  cron.schedule('0 20 * * 0', fire('weekly', 'weekly'), { timezone: 'America/New_York' });

  // Daily 3 AM ET: prune orphaned records (no cookie, no sub, inactive
  // > 30 days). Keeps `users.json` from growing on synthetic-id re-OAuths
  // and abandoned logged-in-only sessions.
  cron.schedule('0 3 * * *', () => {
    try { pruneOrphaned(); } catch (e) { console.error('[cron] pruneOrphaned failed:', e); }
  }, { timezone: 'America/New_York' });
}

// On boot, recover a missed run. If we're already past noon ET today
// and the last successful run was on a prior date (in ET), fire once.
// Avoids the failure mode where the service restarts between 12:00pm
// and tomorrow's cron, silently skipping today. (The evening pass also
// bumps last_run_at, which is fine — any successful check-run today
// means today wasn't skipped.)
// Returns the runNotifications promise (or null when no recovery
// needed) so the caller can await — chaining run+digest sequentially
// matters because runNotifications throws on cross-mode overlap.
export function maybeRecoverMissedRun() {
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const todayET = fmtDate.format(new Date());
  const hourET = parseInt(fmtHour.format(new Date()), 10);
  if (hourET < 12) return null;
  const last = loadStore().last_run_at;
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
  const last = loadStore().last_digest_run_at;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return null;
  console.log(`[cron] recovering missed digest (last: ${lastDateET || 'never'}, today: ${todayET})`);
  return runNotifications({ mode: 'weekly' });
}

// Day-of recovery: the 07:00 last call is the most time-critical DM in
// the system — a restart across 7am on a sweep day must not eat it. Only
// meaningful before noon (the sweep window is 8AM-12PM; past noon the
// daily run takes over), and runNotifications self-gates on
// next_event_date so a no-event day is a no-op without any Tesla wake.
export function maybeRecoverMissedDayof() {
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const todayET = fmtDate.format(new Date());
  const hourET = parseInt(fmtHour.format(new Date()), 10);
  if (hourET < 7 || hourET >= 12) return null;
  const last = loadStore().last_dayof_run_at;
  const lastDateET = last ? fmtDate.format(new Date(last)) : null;
  if (lastDateET === todayET) return null;
  console.log(`[cron] recovering missed day-of run (last: ${lastDateET || 'never'}, today: ${todayET})`);
  return runNotifications({ mode: 'dayof' });
}

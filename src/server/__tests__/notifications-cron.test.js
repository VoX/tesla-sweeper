import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock everything the cron touches; the test exercises mode validation,
// single-flight behavior, and stub-vehicle short-circuit logic.

vi.mock('../store/users.js', () => ({
  loadStore: vi.fn(),
  saveStore: vi.fn(),
  patchSub: vi.fn(),
  loadSubscribedUsers: vi.fn(),
}));

vi.mock('../integrations/tesla.js', () => ({
  STUB_VEHICLE_ENABLED: true,
  STUB_REFRESH_TOKEN: 'STUB_REFRESH_TOKEN',
  STUB_VEHICLE_LAT: 42.385,
  STUB_VEHICLE_LNG: -71.108,
  teslaTokenExchange: vi.fn(),
  fetchVehicleData: vi.fn(),
}));

vi.mock('../integrations/nominatim.js', () => ({
  reverseGeocodeLocation: vi.fn().mockResolvedValue({
    street: 'Harvard St', house_number: '12', city: 'Somerville', display_name: '12 Harvard St',
  }),
}));

vi.mock('../integrations/slack.js', () => ({
  postSlackDM: vi.fn().mockResolvedValue({ ok: true }),
}));

// Use a sweep-event date 2 days in the future from "today" (in ET) so the
// planner's window filter (`d >= 0 && d <= 7`) accepts it AND
// `shouldDispatchPlan` (1 ≤ daysUntilPrimary ≤ 3) fires. Hard-coded dates
// drift past the window as wall-clock advances.
const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const inDays = (n) => {
  const d = new Date(todayET + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
vi.mock('../sweep/check.js', () => ({
  runSweepCheck: vi.fn(),
}));
const { runSweepCheck } = await import('../sweep/check.js');
runSweepCheck.mockResolvedValue({
  found: true, days_until_next: 2, status: 'warning', title: 'Move', message: 'soon',
  car_side: 'even', sweep_events: [{ date: inDays(2), side: 'even', time: '8:00 AM - 12:00 PM' }],
  side_detection: { side: 'even', car_house_number: 12 },
  house_num: 12, latitude: 42.385, longitude: -71.108,
});

const { loadStore, saveStore, patchSub, loadSubscribedUsers } = await import('../store/users.js');
const { postSlackDM } = await import('../integrations/slack.js');
const { runNotifications } = await import('../notifications/cron.js');

const SUB = {
  id: 'sub1', slack_user_id: 'U060NLFUM', vehicle_id: '999999999999999',
  vehicle_name: 'Test Vehicle', refresh_token: 'STUB_REFRESH_TOKEN',
};

beforeEach(() => {
  vi.clearAllMocks();
  // loadStore is only used by the run-timestamp write + recovery helpers.
  loadStore.mockReturnValue({ users: [] });
  // loadSubscribedUsers is the cron's working set.
  loadSubscribedUsers.mockReturnValue([{ ...SUB }]);
});

describe('runNotifications mode validation', () => {
  it('throws on invalid mode', async () => {
    await expect(runNotifications({ mode: 'monthly' })).rejects.toThrow(/invalid mode/);
  });

  it("accepts mode='daily'", async () => {
    const out = await runNotifications({ mode: 'daily' });
    expect(out).toHaveProperty('mode', 'daily');
  });

  it("accepts mode='weekly'", async () => {
    const out = await runNotifications({ mode: 'weekly' });
    expect(out).toHaveProperty('mode', 'weekly');
  });

  it("defaults to mode='daily' when omitted", async () => {
    const out = await runNotifications();
    expect(out).toHaveProperty('mode', 'daily');
  });
});

describe('runNotifications stub vehicle short-circuit', () => {
  it('does not call teslaTokenExchange or fetchVehicleData for stub subs', async () => {
    const { teslaTokenExchange, fetchVehicleData } = await import('../integrations/tesla.js');
    const out = await runNotifications({ mode: 'daily' });
    expect(teslaTokenExchange).not.toHaveBeenCalled();
    expect(fetchVehicleData).not.toHaveBeenCalled();
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].battery_level).toBe(78);
  });
});

describe('runNotifications dispatch', () => {
  it("daily mode sends a DM via formatPlanDM when plan triggers", async () => {
    const out = await runNotifications({ mode: 'daily' });
    // Sweep-check returns days_until_next=2, side=even — planner would fire.
    expect(out.results[0].plan).toBeDefined();
    // Must actually have called postSlackDM with the addressed user. A
    // green test on plan-defined alone would silently pass even if the
    // dispatch loop were deleted.
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('Move'));
    // And persisted last_dm_date so a same-day re-run dedupes.
    const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    expect(patchSub).toHaveBeenCalledWith('sub1', { last_dm_date: todayET });
  });

  it('clears last_dm_error_at on recovery so a future outage can DM immediately', async () => {
    // Sub had a stuck-DM cooldown set last week; this run succeeds.
    loadSubscribedUsers.mockReturnValue([{
      ...SUB, last_dm_error_at: '2026-04-30T17:00:00.000Z', consecutive_failures: 5,
    }]);
    await runNotifications({ mode: 'daily' });
    // The persist call should include last_dm_error_at: null. Find it.
    const persistCall = patchSub.mock.calls.find(([id, patch]) => id === 'sub1' && 'last_check_at' in patch);
    expect(persistCall).toBeDefined();
    expect(persistCall[1].last_dm_error_at).toBeNull();
    expect(persistCall[1].consecutive_failures).toBe(0);
  });

  it('weekly mode uses last_digest_date for dedup', async () => {
    // Pre-set last_digest_date to today's ET date so the dedup branch skips
    // the DM. Today's ET-format date:
    const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    loadSubscribedUsers.mockReturnValue([{ ...SUB, last_digest_date: todayET }]);
    const out = await runNotifications({ mode: 'weekly' });
    expect(out.results[0].digest_skipped).toBe('already-sent-today');
    // Slack DM should NOT have fired this run (the existing all-clear from
    // beforeEach reset the mock; only confirm it wasn't called for the digest)
    const digestDmCalls = postSlackDM.mock.calls.filter(args => args[1]?.includes('schedule for the week'));
    expect(digestDmCalls).toHaveLength(0);
  });
});

describe('runNotifications single-flight', () => {
  it('two same-mode concurrent calls dedupe to one underlying run', async () => {
    // The outer async function wraps return values in fresh Promises,
    // so we can't compare p1 === p2 directly. Instead verify the
    // underlying ran_at timestamp is identical across both resolutions.
    const [r1, r2] = await Promise.all([
      runNotifications({ mode: 'daily' }),
      runNotifications({ mode: 'daily' }),
    ]);
    expect(r1.ran_at).toBe(r2.ran_at);
    expect(r1).toBe(r2); // single underlying object identity
  });

  it('rejects when a different mode is in flight', async () => {
    // Trigger two calls in the same tick — second one (different mode)
    // should reject before its promise resolves.
    const p1 = runNotifications({ mode: 'daily' });
    await expect(runNotifications({ mode: 'weekly' })).rejects.toThrow(/another run already in flight/);
    await p1;
  });
});

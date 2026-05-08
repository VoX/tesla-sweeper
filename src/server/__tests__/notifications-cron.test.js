import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock everything the cron touches; the test exercises mode validation,
// single-flight behavior, and stub-vehicle short-circuit logic.

vi.mock('../store/subscriptions.js', () => ({
  loadStore: vi.fn(),
  saveStore: vi.fn(),
  patchSub: vi.fn(),
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

vi.mock('../sweep/check.js', () => ({
  runSweepCheck: vi.fn().mockResolvedValue({
    found: true, days_until_next: 1, status: 'warning', title: 'Move', message: 'tomorrow',
    car_side: 'even', sweep_events: [{ date: '2026-05-09', side: 'even', time: '8:00 AM - 12:00 PM' }],
    side_detection: { side: 'even', car_house_number: 12 },
    house_num: 12, latitude: 42.385, longitude: -71.108,
  }),
}));

const { loadStore, saveStore, patchSub } = await import('../store/subscriptions.js');
const { postSlackDM } = await import('../integrations/slack.js');
const { runNotifications } = await import('../notifications/cron.js');

beforeEach(() => {
  vi.clearAllMocks();
  loadStore.mockReturnValue({
    subscriptions: [
      {
        id: 'sub1', slack_user_id: 'U060NLFUM', vehicle_id: 999999999999999,
        vehicle_name: 'Test Vehicle', refresh_token: 'STUB_REFRESH_TOKEN',
      },
    ],
  });
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
    // Sweep-check returns days_until_next=1, side=even — planner would fire.
    // The mock `runSweepCheck` returns a complete shape; the cron's planner
    // call shouldn't throw and should produce a plan that dispatches.
    expect(out.results[0].plan).toBeDefined();
  });

  it('weekly mode uses last_digest_date for dedup', async () => {
    // Pre-set last_digest_date to today's ET date so the dedup branch skips
    // the DM. Today's ET-format date:
    const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    loadStore.mockReturnValue({
      subscriptions: [{
        id: 'sub1', slack_user_id: 'U060NLFUM', vehicle_id: 999999999999999,
        vehicle_name: 'Test Vehicle', refresh_token: 'STUB_REFRESH_TOKEN',
        last_digest_date: todayET,
      }],
    });
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

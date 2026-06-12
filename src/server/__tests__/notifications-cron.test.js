import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock everything the cron touches; the tests exercise mode validation,
// the stub-vehicle short-circuit, the real (getTeslaAccess) vehicle path,
// dispatch/dedup (plan-aware keys), the season gate, day-of last call,
// stuck-sub class routing, and single-flight behavior.
//
// All runs pass an explicit in-season `todayET` — deriving "today" from
// the wall clock made the suite date-dependent (and the Jan–Mar season
// gate would fail every dispatch test all winter).

process.env.OPERATOR_SLACK_ID = 'U0OPERATOR';

vi.mock('../store/users.js', () => ({
  loadStore: vi.fn(),
  saveStore: vi.fn(),
  patchUser: vi.fn(),
  loadSubscribedUsers: vi.fn(),
  pruneOrphaned: vi.fn(),
}));

vi.mock('../integrations/tesla.js', () => ({
  STUB_VEHICLE_ENABLED: true,
  STUB_REFRESH_TOKEN: 'STUB_REFRESH_TOKEN',
  STUB_VEHICLE_LAT: 42.385,
  STUB_VEHICLE_LNG: -71.108,
  // The stub-detection moved from token-based to vehicle-id-based — the
  // SUB fixture below has vehicle_id = '999999999999999' (the stub id).
  isStubVehicle: (id) => String(id) === '999999999999999',
  fetchVehicleData: vi.fn(),
}));

vi.mock('../integrations/tesla-auth.js', () => ({
  getTeslaAccess: vi.fn(),
}));

vi.mock('../integrations/nominatim.js', () => ({
  reverseGeocodeLocation: vi.fn().mockResolvedValue({
    street: 'Harvard St', house_number: '12', city: 'Somerville', display_name: '12 Harvard St',
  }),
}));

vi.mock('../integrations/slack.js', () => ({
  postSlackDM: vi.fn().mockResolvedValue({ ok: true }),
  // planner.js (unmocked) imports this from the mocked module — give it
  // the real behavior so DM text assertions stay meaningful.
  escapeSlack: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}));

// Fixed in-season anchor date; events placed relative to it.
const TODAY = '2026-07-01';
const inDays = (n) => {
  const d = new Date(TODAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

vi.mock('../sweep/check.js', () => ({
  runSweepCheck: vi.fn(),
}));
const { runSweepCheck } = await import('../sweep/check.js');
// Default fixture: user-side sweep 3 days out → heads-up dispatch fires.
const SWEEP_T3 = {
  found: true, days_until_next: 3, status: 'warning', title: 'Move', message: 'soon',
  car_side: 'even', sweep_events: [{ date: inDays(3), side: 'even', time: '8:00 AM - 12:00 PM' }],
  side_detection: { side: 'even', car_house_number: 12 },
  house_num: 12, latitude: 42.385, longitude: -71.108,
};

const { loadStore, patchUser, loadSubscribedUsers } = await import('../store/users.js');
const { postSlackDM } = await import('../integrations/slack.js');
const { getTeslaAccess } = await import('../integrations/tesla-auth.js');
const { fetchVehicleData } = await import('../integrations/tesla.js');
const { runNotifications, planDmKey } = await import('../notifications/cron.js');

const SUB = {
  id: 'sub1', slack_user_id: 'U060NLFUM', vehicle_id: '999999999999999',
  vehicle_name: 'Test Vehicle', refresh_token: 'STUB_REFRESH_TOKEN',
};

const run = (opts = {}) => runNotifications({ todayET: TODAY, ...opts });

beforeEach(() => {
  vi.clearAllMocks();
  runSweepCheck.mockResolvedValue(SWEEP_T3);
  // loadStore is only used by the run-timestamp write + recovery helpers.
  loadStore.mockReturnValue({ users: [] });
  // loadSubscribedUsers is the cron's working set.
  loadSubscribedUsers.mockReturnValue([{ ...SUB }]);
});

describe('runNotifications mode validation', () => {
  it('throws on invalid mode', async () => {
    await expect(run({ mode: 'monthly' })).rejects.toThrow(/invalid mode/);
  });

  it.each(['daily', 'evening', 'dayof', 'weekly'])("accepts mode='%s'", async (mode) => {
    const out = await run({ mode });
    expect(out).toHaveProperty('mode', mode);
  });

  it("defaults to mode='daily' when omitted", async () => {
    const out = await run();
    expect(out).toHaveProperty('mode', 'daily');
  });
});

describe('runNotifications stub vehicle short-circuit', () => {
  it('does not touch Tesla (getTeslaAccess / fetchVehicleData) for stub subs', async () => {
    const out = await run({ mode: 'daily' });
    expect(getTeslaAccess).not.toHaveBeenCalled();
    expect(fetchVehicleData).not.toHaveBeenCalled();
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].battery_level).toBe(78);
  });
});

describe('runNotifications real (non-stub) vehicle path', () => {
  it('goes through getTeslaAccess for a real refresh_token and uses the access_token in the vehicle_data call', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, vehicle_id: '1234567890123456', refresh_token: 'RT_real' }]);
    getTeslaAccess.mockResolvedValue('AT_live');
    fetchVehicleData.mockResolvedValue({ response: {
      drive_state: { latitude: 42.385, longitude: -71.108 },
      charge_state: { battery_level: 64 },
    } });
    const out = await run({ mode: 'daily' });
    expect(getTeslaAccess).toHaveBeenCalledWith('sub1');
    expect(fetchVehicleData).toHaveBeenCalledWith(
      expect.objectContaining({ Authorization: 'Bearer AT_live' }),
      '1234567890123456',
    );
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].battery_level).toBe(64);
  });

  it('surfaces a getTeslaAccess failure as a per-sub error + bumps consecutive_failures + tags the class', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, vehicle_id: '1234567890123456', refresh_token: 'RT_dead', consecutive_failures: 0 }]);
    const err = new Error('Tesla refused the refresh_token: invalid_grant');
    err.name = 'RevokedError';
    getTeslaAccess.mockRejectedValue(err);
    const out = await run({ mode: 'daily' });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toMatch(/invalid_grant/);
    expect(out.results[0].error_class).toBe('RevokedError');
    expect(out.results[0].consecutive_failures).toBe(1);
    expect(fetchVehicleData).not.toHaveBeenCalled();
  });
});

describe('runNotifications dispatch — plan-aware dedup', () => {
  it('daily mode sends a DM via formatPlanDM when plan triggers, persisting the plan key', async () => {
    const out = await run({ mode: 'daily' });
    expect(out.results[0].plan).toBeDefined();
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('Move'));
    const key = planDmKey(TODAY, out.results[0].plan);
    expect(patchUser).toHaveBeenCalledWith('sub1', { last_dm_date: TODAY, last_dm_key: key });
  });

  it('evening re-run with an UNCHANGED plan dedupes on the key', async () => {
    const key = `${TODAY}|lone-flip|${inDays(3)}`;
    loadSubscribedUsers.mockReturnValue([{ ...SUB, last_dm_key: key, last_dm_date: TODAY }]);
    const out = await run({ mode: 'evening' });
    expect(out.results[0].dm_skipped).toBe('already-sent');
    expect(postSlackDM).not.toHaveBeenCalled();
  });

  it('evening re-run with a CHANGED plan re-DMs (car moved, advice differs)', async () => {
    // Stored key is for a different primary-event date → plan changed.
    loadSubscribedUsers.mockReturnValue([{ ...SUB, last_dm_key: `${TODAY}|lone-flip|${inDays(1)}`, last_dm_date: TODAY }]);
    const out = await run({ mode: 'evening' });
    expect(out.results[0].dm_sent).toBe(true);
  });

  it('legacy records without last_dm_key fall back to date-only dedup for the transition', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, last_dm_date: TODAY }]);
    const out = await run({ mode: 'evening' });
    expect(out.results[0].dm_skipped).toBe('already-sent');
  });

  it('day-1 plan DM carries the LAST CALL framing', async () => {
    runSweepCheck.mockResolvedValue({
      ...SWEEP_T3, days_until_next: 1,
      sweep_events: [{ date: inDays(1), side: 'even', time: '8:00 AM - 12:00 PM' }],
    });
    await run({ mode: 'daily' });
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('LAST CALL'));
  });

  it('persists next_event_date from the plan for the day-of gate', async () => {
    await run({ mode: 'daily' });
    const persistCall = patchUser.mock.calls.find(([id, patch]) => id === 'sub1' && 'last_check_at' in patch);
    expect(persistCall[1].next_event_date).toBe(inDays(3));
  });

  it('clears last_dm_error_at on recovery so a future outage can DM immediately', async () => {
    loadSubscribedUsers.mockReturnValue([{
      ...SUB, last_dm_error_at: '2026-04-30T17:00:00.000Z', consecutive_failures: 5,
    }]);
    await run({ mode: 'daily' });
    const persistCall = patchUser.mock.calls.find(([id, patch]) => id === 'sub1' && 'last_check_at' in patch);
    expect(persistCall).toBeDefined();
    expect(persistCall[1].last_dm_error_at).toBeNull();
    expect(persistCall[1].consecutive_failures).toBe(0);
  });

  it('weekly mode uses last_digest_date for dedup', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, last_digest_date: TODAY }]);
    const out = await run({ mode: 'weekly' });
    expect(out.results[0].digest_skipped).toBe('already-sent-today');
    const digestDmCalls = postSlackDM.mock.calls.filter(args => args[1]?.includes('schedule for the week'));
    expect(digestDmCalls).toHaveLength(0);
  });
});

describe('day-of last call (7am)', () => {
  it('skips the entire run (no locate at all) when no sub has an event today', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, next_event_date: inDays(2) }]);
    const out = await run({ mode: 'dayof' });
    expect(out.results).toHaveLength(0);
    expect(runSweepCheck).not.toHaveBeenCalled();
  });

  it('DMs MOVE NOW when the car is still on the swept side (danger)', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, next_event_date: TODAY }]);
    runSweepCheck.mockResolvedValue({
      ...SWEEP_T3, status: 'danger', title: 'MOVE YOUR CAR',
      message: 'Sweeping TODAY on YOUR side (even side, 8AM-12PM). $50 fine!',
      sweep_events: [{ date: TODAY, side: 'even', time: '8:00 AM - 12:00 PM' }],
    });
    const out = await run({ mode: 'dayof' });
    expect(out.results[0].dm_sent).toBe(true);
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('8AM TODAY'));
    expect(patchUser).toHaveBeenCalledWith('sub1', { last_dayof_date: TODAY });
  });

  it('stays silent when the car is on the safe side', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, next_event_date: TODAY }]);
    runSweepCheck.mockResolvedValue({ ...SWEEP_T3, status: 'warning' });
    const out = await run({ mode: 'dayof' });
    expect(out.results[0].dm_sent).toBeUndefined();
    expect(postSlackDM).not.toHaveBeenCalled();
  });

  it('dedupes on last_dayof_date', async () => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, next_event_date: TODAY, last_dayof_date: TODAY }]);
    runSweepCheck.mockResolvedValue({ ...SWEEP_T3, status: 'danger' });
    const out = await run({ mode: 'dayof' });
    expect(out.results[0].dm_skipped).toBe('already-sent');
    expect(postSlackDM).not.toHaveBeenCalled();
  });
});

describe('season gate (Jan–Mar)', () => {
  it('off-season daily run never locates or DMs', async () => {
    const out = await run({ mode: 'daily', todayET: '2026-02-10' });
    expect(out.off_season).toBe(true);
    expect(out.results).toHaveLength(0);
    expect(runSweepCheck).not.toHaveBeenCalled();
    expect(postSlackDM).not.toHaveBeenCalled();
    expect(patchUser).not.toHaveBeenCalled();
  });

  it('off-season weekly run is skipped outside the preview window', async () => {
    const out = await run({ mode: 'weekly', todayET: '2026-02-15' });
    expect(out.off_season).toBe(true);
    expect(postSlackDM).not.toHaveBeenCalled();
  });

  it('late-March Sunday digest sends the season preview instead (off-season part of the window)', async () => {
    const out = await run({ mode: 'weekly', todayET: '2026-03-26' });
    expect(out.season_preview).toBe(true);
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('season starts Apr 1'));
    expect(patchUser).toHaveBeenCalledWith('sub1', { last_digest_date: '2026-03-26' });
  });

  it.each(['2026-03-29', '2026-03-31', '2026-04-01'])('season-opening ramp date %s passes through the gate', async (d) => {
    const out = await run({ mode: 'daily', todayET: d });
    expect(out.off_season).toBeUndefined();
    expect(out.results).toHaveLength(1);
  });
});

describe('stuck-sub DM class routing', () => {
  const failingSub = (errName) => {
    loadSubscribedUsers.mockReturnValue([{ ...SUB, vehicle_id: '1234567890123456', consecutive_failures: 2 }]);
    const err = new Error('boom');
    err.name = errName;
    getTeslaAccess.mockRejectedValue(err);
  };

  it('RevokedError streak DMs the USER with the re-enable prescription', async () => {
    failingSub('RevokedError');
    await run({ mode: 'daily' });
    expect(postSlackDM).toHaveBeenCalledWith('U060NLFUM', expect.stringContaining('Re-enable'));
  });

  it('TransientError streak DMs the OPERATOR, not the user', async () => {
    failingSub('TransientError');
    await run({ mode: 'daily' });
    expect(postSlackDM).toHaveBeenCalledWith('U0OPERATOR', expect.stringContaining('TransientError'));
    const userCalls = postSlackDM.mock.calls.filter(([to]) => to === 'U060NLFUM');
    expect(userCalls).toHaveLength(0);
  });

  it('evening mode never sends stuck-sub DMs (noon-only)', async () => {
    failingSub('RevokedError');
    await run({ mode: 'evening' });
    expect(postSlackDM).not.toHaveBeenCalled();
  });
});

describe('runNotifications single-flight', () => {
  it('two same-mode concurrent calls dedupe to one underlying run', async () => {
    const [r1, r2] = await Promise.all([
      run({ mode: 'daily' }),
      run({ mode: 'daily' }),
    ]);
    expect(r1.ran_at).toBe(r2.ran_at);
    expect(r1).toBe(r2); // single underlying object identity
  });

  it('rejects when a different mode is in flight', async () => {
    const p1 = run({ mode: 'daily' });
    await expect(run({ mode: 'weekly' })).rejects.toThrow(/another run already in flight/);
    await p1;
  });
});

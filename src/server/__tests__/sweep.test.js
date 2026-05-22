import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three external API modules at the seam — sweep/check is a
// pure composition over them, so mocking lets us walk every status
// branch (today/tomorrow/upcoming/no-events) without HTTP calls.

vi.mock('../integrations/recollect.js', () => ({
  suggestAddress: vi.fn(),
  fetchSweepEvents: vi.fn(),
  parseSweepFlags: vi.fn(),
}));

vi.mock('../integrations/overpass.js', () => ({
  whichSide: vi.fn(),
}));

const { suggestAddress, fetchSweepEvents, parseSweepFlags } = await import('../integrations/recollect.js');
const { whichSide } = await import('../integrations/overpass.js');
const { runSweepCheck } = await import('../sweep/check.js');

const sweep = (date, side, time = '8:00 AM - 12:00 PM') => ({ date, side, time });

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy path: address resolves, raw events get parsed; tests
  // override `parseSweepFlags.mockReturnValue` per scenario.
  suggestAddress.mockResolvedValue([{ place_id: 'p1', name: '12 Harvard St' }]);
  fetchSweepEvents.mockResolvedValue([]);
  parseSweepFlags.mockReturnValue([]);
  whichSide.mockResolvedValue({ side: 'even', car_house_number: 12 });
});

describe('runSweepCheck — branches', () => {
  it('returns found:false when neither the exact address nor any same-side neighbor is indexed', async () => {
    suggestAddress.mockResolvedValue([]); // exact + every fallback probe empty
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.found).toBe(false);
    expect(out.message).toMatch(/not found/);
  });

  it('safe + "no sweeping" when window is empty', async () => {
    parseSweepFlags.mockReturnValueOnce([]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.found).toBe(true);
    expect(out.status).toBe('safe');
    expect(out.title).toMatch(/No Sweeping/);
  });

  it('danger when sweep is today on user-side and not past noon', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-08', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', past_noon: false, lat: 42.3, lng: -71.1 });
    expect(out.status).toBe('danger');
    expect(out.title).toMatch(/MOVE/);
    expect(out.message).toMatch(/\$50 fine/);
  });

  it('info + "Sweeping Done for Today" when past_noon is true', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-08', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', past_noon: true, lat: 42.3, lng: -71.1 });
    expect(out.status).toBe('info');
    expect(out.title).toMatch(/Done for Today/);
  });

  it('warning when sweep is tomorrow on user-side', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-09', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.status).toBe('warning');
    expect(out.title).toMatch(/Tomorrow.*YOUR/);
  });

  it('info when sweep is tomorrow on the OTHER side', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-09', 'odd')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.status).toBe('info');
    expect(out.title).toMatch(/Other Side/);
  });

  it('safe + "You\'re Good" when next sweep is several days out', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.status).toBe('safe');
    expect(out.title).toMatch(/Good/);
    expect(out.days_until_next).toBe(7);
  });
});

describe('runSweepCheck — house_num canonicalization', () => {
  it('uses OSM-detected car_house_number when available', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    whichSide.mockResolvedValueOnce({ side: 'even', car_house_number: 12 });
    const out = await runSweepCheck({ address: '9 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.house_num).toBe(12);
  });

  it('falls back to address-parsed house number when OSM lacks data', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    whichSide.mockResolvedValueOnce({ side: 'unknown' });
    const out = await runSweepCheck({ address: '9 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.house_num).toBe(9);
    expect(out.side_source).toBe('house_parity');
  });

  it('handles whichSide throwing without crashing the check', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'odd')]);
    whichSide.mockRejectedValueOnce(new Error('Overpass 504'));
    const out = await runSweepCheck({ address: '9 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.found).toBe(true);
    expect(out.side_source).toBe('house_parity');
    expect(out.car_side).toBe('odd');
  });
});

describe('runSweepCheck — response shape', () => {
  it('returns the documented field set', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    for (const k of ['found', 'place_name', 'status', 'title', 'message', 'sweep_events',
      'car_side', 'side_source', 'side_detection', 'house_num', 'days_until_next', 'latitude', 'longitude']) {
      expect(out).toHaveProperty(k);
    }
    expect(out.latitude).toBe(42.3);
    expect(out.longitude).toBe(-71.1);
  });
});

describe('runSweepCheck — out-of-Somerville city guard', () => {
  it('short-circuits (no Recollect query) when the geocoded city is not Somerville', async () => {
    const out = await runSweepCheck({ address: '20 Oak Street', city: 'Cambridge', today_date: '2026-05-08', lat: 42.374, lng: -71.099 });
    expect(out.found).toBe(false);
    expect(out.message).toMatch(/Cambridge/);
    expect(suggestAddress).not.toHaveBeenCalled();
    expect(fetchSweepEvents).not.toHaveBeenCalled();
  });

  it('proceeds normally when the city is Somerville', async () => {
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    const out = await runSweepCheck({ address: '12 Harvard St', city: 'Somerville', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(suggestAddress).toHaveBeenCalled();
    expect(out.found).toBe(true);
    expect(out.message || '').not.toMatch(/outside Somerville/);
  });

  it('proceeds when city is absent (guard fails open, never blocks a real lookup)', async () => {
    const out = await runSweepCheck({ address: '12 Harvard St', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(suggestAddress).toHaveBeenCalled();
    expect(out.found).toBe(true);
  });
});

describe('runSweepCheck — nearest-same-side fallback for Recollect gaps', () => {
  it('uses the nearest indexed same-side address when the exact number is missing', async () => {
    // Exact "36 ..." misses; any neighbor probe returns an indexed parcel.
    suggestAddress.mockImplementation(async (q) =>
      q.startsWith('36 ') ? [] : [{ place_id: 'pNbr', name: '38 Atherton St, Somerville' }]);
    parseSweepFlags.mockReturnValueOnce([sweep('2026-05-15', 'even')]);
    const out = await runSweepCheck({ address: '36 Atherton Street', city: 'Somerville', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.found).toBe(true);
    expect(out.place_id).toBe('pNbr');
    expect(out.nearest_note).toMatch(/38 Atherton St/);
    expect(out.message).toMatch(/nearest indexed address/);
  });

  it('still returns not-found when no same-side neighbor is indexed', async () => {
    suggestAddress.mockResolvedValue([]); // exact + every probe empty
    const out = await runSweepCheck({ address: '36 Atherton Street', city: 'Somerville', today_date: '2026-05-08', lat: 42.3, lng: -71.1 });
    expect(out.found).toBe(false);
    expect(out.message).toMatch(/not found/i);
  });
});

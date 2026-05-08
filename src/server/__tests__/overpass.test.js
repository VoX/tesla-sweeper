import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const realFetch = globalThis.fetch;

beforeEach(() => { globalThis.fetch = vi.fn(); });
afterEach(async () => {
  globalThis.fetch = realFetch;
  const { _resetSideCache } = await import('../integrations/overpass.js');
  _resetSideCache();
  vi.restoreAllMocks();
});

const namedWaysResponse = {
  ok: true,
  json: async () => ({ elements: [{
    type: 'way',
    id: 1,
    tags: { highway: 'residential', name: 'Harvard St' },
    geometry: [{ lat: 42.385, lon: -71.108 }, { lat: 42.386, lon: -71.108 }],
  }] }),
};
const buildingsResponse = {
  ok: true,
  json: async () => ({ elements: [
    { type: 'node', lat: 42.3855, lon: -71.1079, tags: { 'addr:housenumber': '12', 'addr:street': 'Harvard St' } },
    { type: 'node', lat: 42.3855, lon: -71.1081, tags: { 'addr:housenumber': '13', 'addr:street': 'Harvard St' } },
  ] }),
};

describe('whichSide cache + retry', () => {
  it('retries up to 3 times on overpass throw before propagating', async () => {
    globalThis.fetch
      .mockRejectedValueOnce(new Error('timeout 1'))
      .mockRejectedValueOnce(new Error('timeout 2'))
      .mockRejectedValueOnce(new Error('timeout 3'));
    const { whichSide } = await import('../integrations/overpass.js');
    await expect(whichSide(42.385, -71.108)).rejects.toThrow(/timeout 3/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on a later attempt after earlier failures', async () => {
    globalThis.fetch
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(namedWaysResponse)
      .mockResolvedValueOnce(buildingsResponse);
    const { whichSide } = await import('../integrations/overpass.js');
    const r = await whichSide(42.385, -71.108);
    expect(['odd', 'even', 'unknown']).toContain(r.side);
    // 3 calls: 1 retry-failure + 2 successful (named ways + buildings)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('caches a definite side for 30 days — second call hits cache, no overpass round-trip', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(namedWaysResponse)
      .mockResolvedValueOnce(buildingsResponse);
    const { whichSide } = await import('../integrations/overpass.js');
    // Query point slightly east of the (vertical) road so cross-sign
    // is non-zero and the result is 'odd' or 'even' (not 'unknown').
    const r1 = await whichSide(42.38505, -71.10790);
    expect(['odd', 'even']).toContain(r1.side);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Same coords (within 5-decimal rounding) → cache hit, no new fetch.
    const r2 = await whichSide(42.385051, -71.107901);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(r2).toEqual(r1);
  });

  it('does NOT cache "unknown" results so OSM data improvements get a fresh probe', async () => {
    // First call: named-ways query returns no ways → side='unknown'.
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ elements: [] }) });
    const { whichSide } = await import('../integrations/overpass.js');
    const r1 = await whichSide(40, -73);
    expect(r1.side).toBe('unknown');
    // Second call: same coords, but cache should NOT have stored
    // 'unknown' — so we should hit overpass again.
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ elements: [] }) });
    await whichSide(40, -73);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

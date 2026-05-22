import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the HTTP seam so suggestAddress runs without network.
vi.mock('../util/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
  UA: 'test-ua',
}));

const { fetchWithTimeout } = await import('../util/fetch.js');
const { suggestAddress } = await import('../integrations/recollect.js');

const resp = (arr) => ({ ok: true, json: async () => arr });

beforeEach(() => { vi.clearAllMocks(); });

describe('suggestAddress — Somerville-only filtering', () => {
  // Recollect's Somerville endpoint fuzzy-matches into other municipalities;
  // those results carry a foreign sweeping schedule and must be dropped, or the
  // caller silently reports another city's schedule as the user's.
  it('drops cross-municipality matches (service_id != 349)', async () => {
    fetchWithTimeout.mockResolvedValue(resp([
      { name: '15 Union St, Cambridge, Massachusetts', service_id: 761, place_id: 'cam' },
    ]));
    expect(await suggestAddress('15 North Union Street')).toEqual([]);
  });

  it('keeps Somerville (349) results and filters mixed responses', async () => {
    fetchWithTimeout.mockResolvedValue(resp([
      { name: '58 Atherton St, Somerville', service_id: 349, place_id: 'som' },
      { name: '15 Union St, Cambridge', service_id: 761, place_id: 'cam' },
    ]));
    const out = await suggestAddress('58 Atherton Street');
    expect(out.map(s => s.place_id)).toEqual(['som']);
  });

  it('drops items missing a service_id (fails closed to not-found, never wrong-city data)', async () => {
    fetchWithTimeout.mockResolvedValue(resp([{ name: '5 Somewhere St', place_id: 'x' }]));
    expect(await suggestAddress('5 Somewhere Street')).toEqual([]);
  });
});

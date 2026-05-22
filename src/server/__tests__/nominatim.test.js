import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the HTTP seam so reverseGeocodeLocation runs without network.
vi.mock('../util/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
  UA: 'test-ua',
}));

const { fetchWithTimeout } = await import('../util/fetch.js');
const { reverseGeocodeLocation } = await import('../integrations/nominatim.js');

const geoResp = (address) => ({ ok: true, json: async () => ({ address, display_name: 'x' }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('reverseGeocodeLocation — house_number normalization', () => {
  // Regression: OSM tags two-family nodes with a `;`-joined house_number
  // ("58;60"), which Recollect's address-suggest can't match → the old code
  // produced "Address not found" for those (very common) Somerville addresses.
  it('takes the first number of a semicolon-joined house_number', async () => {
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Atherton Street', house_number: '58;60', city: 'Somerville' }));
    const out = await reverseGeocodeLocation(42.3849227, -71.1085474);
    expect(out.house_number).toBe('58');
    expect(out.street).toBe('Atherton Street');
  });

  it('leaves a plain house_number untouched', async () => {
    // Distinct coords dodge the 24h reverse-geocode cache.
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Highland Avenue', house_number: '9', city: 'Somerville' }));
    const out = await reverseGeocodeLocation(42.3900000, -71.1000000);
    expect(out.house_number).toBe('9');
  });
});

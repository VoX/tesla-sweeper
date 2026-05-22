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
  // Recollect's address-suggest only matches a bare leading integer. OSM emits
  // several formats that otherwise produce "Address not found"; reduce them all
  // to the leading integer. Distinct coords per case dodge the 24h cache.

  it('takes the first of a semicolon-joined house_number (two-family)', async () => {
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Atherton Street', house_number: '58;60', city: 'Somerville' }));
    const out = await reverseGeocodeLocation(42.3849227, -71.1085474);
    expect(out.house_number).toBe('58');
    expect(out.street).toBe('Atherton Street');
  });

  it('takes the first of a hyphen range', async () => {
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Josephine Avenue', house_number: '134-136', city: 'Somerville' }));
    const out = await reverseGeocodeLocation(42.3990000, -71.1190000);
    expect(out.house_number).toBe('134');
  });

  it('drops a letter/rear suffix and a fractional', async () => {
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Highland Avenue', house_number: '215B', city: 'Somerville' }));
    expect((await reverseGeocodeLocation(42.3900000, -71.1000000)).house_number).toBe('215');
    fetchWithTimeout.mockResolvedValue(geoResp({ road: 'Boston Street', house_number: '25 1/2', city: 'Somerville' }));
    expect((await reverseGeocodeLocation(42.3800000, -71.0950000)).house_number).toBe('25');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readCachedCheck, saveCachedCheck, clearCachedCheck } from '../lib/cache.js';

beforeEach(() => {
  localStorage.clear();
});

describe('readCachedCheck', () => {
  it('returns null for missing entries', () => {
    expect(readCachedCheck('v1')).toBeNull();
  });

  it('returns null when no vehicleId is supplied', () => {
    expect(readCachedCheck()).toBeNull();
    expect(readCachedCheck(null)).toBeNull();
  });

  it('returns null when version mismatches', () => {
    localStorage.setItem('tesla_last_check', JSON.stringify({ v: 999, vehicle_id: 'v1', at: Date.now() }));
    expect(readCachedCheck('v1')).toBeNull();
  });

  it('returns null when vehicle_id mismatches', () => {
    localStorage.setItem('tesla_last_check', JSON.stringify({ v: 1, vehicle_id: 'v2', at: Date.now() }));
    expect(readCachedCheck('v1')).toBeNull();
  });

  it('returns null for entries older than 6h', () => {
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    localStorage.setItem('tesla_last_check', JSON.stringify({ v: 1, vehicle_id: 'v1', at: sevenHoursAgo }));
    expect(readCachedCheck('v1')).toBeNull();
  });

  it('returns the cached object for valid recent entries', () => {
    saveCachedCheck('v1', { mapPos: { lat: 1, lng: 2 }, vehicleInfo: { name: 'X' } });
    const out = readCachedCheck('v1');
    expect(out).not.toBeNull();
    expect(out.mapPos).toEqual({ lat: 1, lng: 2 });
    expect(out.vehicleInfo).toEqual({ name: 'X' });
  });

  it('returns null on malformed JSON without throwing', () => {
    localStorage.setItem('tesla_last_check', 'not json');
    expect(() => readCachedCheck('v1')).not.toThrow();
    expect(readCachedCheck('v1')).toBeNull();
  });
});

describe('saveCachedCheck', () => {
  it('stamps version + vehicle_id + at + payload fields', () => {
    saveCachedCheck('v1', { mapPos: { lat: 42 } });
    const stored = JSON.parse(localStorage.getItem('tesla_last_check'));
    expect(stored.v).toBe(1);
    expect(stored.vehicle_id).toBe('v1');
    expect(stored.mapPos).toEqual({ lat: 42 });
    expect(typeof stored.at).toBe('number');
  });

  it('silently no-ops without a vehicleId', () => {
    saveCachedCheck(null, { mapPos: {} });
    expect(localStorage.getItem('tesla_last_check')).toBeNull();
  });
});

describe('clearCachedCheck', () => {
  it('removes the entry', () => {
    saveCachedCheck('v1', {});
    clearCachedCheck();
    expect(localStorage.getItem('tesla_last_check')).toBeNull();
  });

  it('does not throw when the entry is missing', () => {
    expect(() => clearCachedCheck()).not.toThrow();
  });
});

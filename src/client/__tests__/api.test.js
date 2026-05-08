import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { post, get } from '../lib/api.js';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn(); });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('api', () => {
  it('post returns parsed JSON on success', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ x: 1 }) });
    expect(await post('foo', { y: 2 })).toEqual({ x: 1 });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url.endsWith('/foo')).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ y: 2 });
  });

  it('attaches status code on error so callers can branch on 401 without string-matching', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Invalid or expired Tesla token' }),
    });
    try {
      await post('vehicles', { token: 'bad' });
      expect.fail('expected throw');
    } catch (e) {
      expect(e.status).toBe(401);
      expect(e.message).toBe('Invalid or expired Tesla token');
    }
  });

  it('falls back to "API error" when server response is unparseable', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    });
    try {
      await get('status');
      expect.fail('expected throw');
    } catch (e) {
      expect(e.status).toBe(502);
      expect(e.message).toBe('API error');
    }
  });

  it('forwards AbortSignal to fetch', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const ctrl = new AbortController();
    await post('foo', {}, ctrl.signal);
    expect(globalThis.fetch.mock.calls[0][1].signal).toBe(ctrl.signal);
  });
});
